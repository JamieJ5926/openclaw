// Check Cli Startup Memory tests cover check cli startup memory script behavior.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { testing } from "../../scripts/check-cli-startup-memory.mjs";
import { withEnv } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function expectNoNodeStack(stderr: string): void {
  expect(stderr).not.toContain("Node.js");
  expect(stderr).not.toContain("\n    at ");
}

function runStartupMemoryCheckWithHelpSamples(
  helpSamplesMb: number[],
  tempRoot = tempRoots.make("openclaw-startup-memory-test-"),
) {
  let sampleIndex = 0;
  return testing.runStartupMemoryCheck(
    [
      "--json",
      path.join(tempRoot, "startup-memory.json"),
      "--summary",
      path.join(tempRoot, "summary.md"),
    ],
    {
      platform: "linux",
      spawnSync: () => {
        const caseIndex = Math.floor(sampleIndex / testing.sampleCount);
        const caseSampleIndex = sampleIndex % testing.sampleCount;
        sampleIndex += 1;
        const rssMb = caseIndex === 0 ? (helpSamplesMb[caseSampleIndex] ?? 1) : 1;
        return {
          signal: null,
          status: 0,
          stderr: `__OPENCLAW_MAX_RSS_KB__=${rssMb * 1024}\n`,
          stdout: "",
        };
      },
    },
  );
}

describe("check-cli-startup-memory", () => {
  it("resolves the repository root from the script location", () => {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const scriptUrl = pathToFileURL(path.join(repoRoot, "scripts/check-cli-startup-memory.mjs"));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `const mod = await import(${JSON.stringify(scriptUrl.href)}); console.log(mod.testing.repoRoot);`,
      ],
      {
        cwd: path.join(repoRoot, "test/scripts"),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(repoRoot);
  });

  it("keeps the Linux help startup budget tight while allowing macOS RSS overhead", () => {
    expect(testing.resolveDefaultLimitsMb("linux").help).toBe(100);
    expect(testing.resolveDefaultLimitsMb("darwin").help).toBeGreaterThan(100);
  });

  it("guards packaged plugin listing startup memory", () => {
    expect(testing.resolveDefaultLimitsMb("linux").pluginsList).toBe(400);
    expect(testing.resolveDefaultLimitsMb("darwin").pluginsList).toBeGreaterThan(350);
    expect(testing.cases).toContainEqual(
      expect.objectContaining({
        id: "pluginsList",
        args: ["openclaw.mjs", "plugins", "list", "--json"],
      }),
    );
  });

  it("keeps status startup headroom above Linux runner RSS variance", () => {
    expect(testing.resolveDefaultLimitsMb("linux").statusJson).toBe(450);
  });

  it("applies bounded runner RSS tolerance to the median of three cold-start samples", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    const helpLimitMb = testing.resolveDefaultLimitsMb(process.platform).help;
    const helpSamplesMb = [helpLimitMb + 20, helpLimitMb + 0.5, helpLimitMb - 20];
    const result = runStartupMemoryCheckWithHelpSamples(helpSamplesMb, tempRoot);

    expect(result.results[0]).toMatchObject({
      limitMb: helpLimitMb,
      rssToleranceMb: 1,
      effectiveLimitMb: helpLimitMb + 1,
      maxRssMb: helpLimitMb + 0.5,
      rssSamplesMb: helpSamplesMb,
      status: "pass",
    });
    const report = JSON.parse(readFileSync(path.join(tempRoot, "startup-memory.json"), "utf8"));
    expect(report.results[0]).toMatchObject({
      limitMb: helpLimitMb,
      rssToleranceMb: 1,
      effectiveLimitMb: helpLimitMb + 1,
      rssSamplesMb: helpSamplesMb,
    });
    expect(readFileSync(path.join(tempRoot, "summary.md"), "utf8")).toContain(
      `base limit ${helpLimitMb.toFixed(1)} MB; RSS tolerance 1.0 MB; effective ceiling ${(helpLimitMb + 1).toFixed(1)} MB; samples: ${helpSamplesMb.map((sample) => `${sample.toFixed(1)} MB`).join(", ")}`,
    );
  });

  it("still fails when most cold-start RSS samples exceed the bounded tolerance", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const helpLimitMb = testing.resolveDefaultLimitsMb(process.platform).help;
    const helpSamplesMb = [helpLimitMb + 1.5, helpLimitMb + 1.25, helpLimitMb - 20];

    expect(() => runStartupMemoryCheckWithHelpSamples(helpSamplesMb)).toThrow(
      `--help median max RSS ${(helpLimitMb + 1.25).toFixed(1)} MB exceeded effective ceiling ${helpLimitMb + 1} MB (base limit ${helpLimitMb} MB; RSS tolerance 1 MB; samples: ${helpSamplesMb.map((sample) => sample.toFixed(1)).join(", ")} MB)`,
    );
  });

  it("keeps invalid startup memory env values from bypassing budgets", () => {
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "abc",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "1e3",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "0x10",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(() =>
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "0",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_HELP_MB must be a positive number");
    expect(
      testing.readPositiveNumberEnv("OPENCLAW_STARTUP_MEMORY_HELP_MB", 100, {
        OPENCLAW_STARTUP_MEMORY_HELP_MB: "125.5",
      }),
    ).toBe(125.5);
  });

  it("keeps invalid startup memory timeout env values from parsing loosely", () => {
    expect(() =>
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS must be a positive number");
    expect(() =>
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: "1000.5",
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS must be a positive integer");
    expect(() =>
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: String(Number.MAX_SAFE_INTEGER + 1),
      }),
    ).toThrow("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS must be a positive integer");
    expect(
      testing.readPositiveIntEnv("OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS", 60_000, {
        OPENCLAW_STARTUP_MEMORY_TIMEOUT_MS: "1000",
      }),
    ).toBe(1000);
  });

  it("rejects missing startup memory artifact paths", () => {
    for (const args of [
      ["--json"],
      ["--json", "--summary"],
      ["--json", "-h"],
      ["--summary"],
      ["--summary", "--json"],
      ["--summary", "-h"],
    ]) {
      expect(() => testing.parseArgs(args)).toThrow(/--(?:json|summary) requires a path/u);
    }
  });

  describe("report path admission", () => {
    const aliasError = "--json and --summary must refer to different files";

    it.each([
      ["same", false],
      ["lexical", false],
      ["symlink-parent", false],
      ["symlink-parent", true],
      ["file-symlink", false],
      ["file-symlink", true],
      ["dangling-file-symlink", false],
      ["dangling-file-symlink", true],
      ["hardlink", false],
      ["hardlink", true],
    ] as const)("rejects %s aliases (reversed: %s) before probing", (kind, reversed) => {
      if (process.platform !== "darwin" && process.platform !== "linux") {
        return;
      }

      const tempRoot = tempRoots.make("openclaw-startup-memory-alias-");
      const reportsDir = path.join(tempRoot, "reports");
      const homeRoot = path.join(tempRoot, "homes");
      mkdirSync(reportsDir);
      mkdirSync(homeRoot);
      const reportPath = path.join(reportsDir, "report");
      const sentinel = "existing report must survive admission\n";
      let aliasPath = reportPath;
      if (kind !== "symlink-parent" && kind !== "dangling-file-symlink") {
        writeFileSync(reportPath, sentinel);
      }
      if (kind === "lexical") {
        aliasPath = path.relative(process.cwd(), reportPath);
      } else if (kind === "symlink-parent") {
        const aliasDir = path.join(tempRoot, "reports-link");
        symlinkSync(reportsDir, aliasDir, "dir");
        aliasPath = path.join(aliasDir, "report");
      } else if (kind === "file-symlink") {
        aliasPath = path.join(reportsDir, "report-link");
        symlinkSync(reportPath, aliasPath, "file");
      } else if (kind === "dangling-file-symlink") {
        aliasPath = path.join(reportsDir, "report-link");
        symlinkSync(path.basename(reportPath), aliasPath, "file");
      } else if (kind === "hardlink") {
        aliasPath = path.join(reportsDir, "report-link");
        linkSync(reportPath, aliasPath);
      }
      const [jsonPath, summaryPath] = reversed ? [aliasPath, reportPath] : [reportPath, aliasPath];
      let probes = 0;

      withEnv({ TMPDIR: homeRoot, TEMP: homeRoot, TMP: homeRoot }, () => {
        expect
          .soft(() =>
            testing.runStartupMemoryCheck(["--json", jsonPath, "--summary", summaryPath], {
              platform: process.platform,
              spawnSync: () => {
                probes += 1;
                return {
                  status: 0,
                  signal: null,
                  stdout: "",
                  stderr: "__OPENCLAW_MAX_RSS_KB__=1024\n",
                };
              },
            }),
          )
          .toThrow(aliasError);
      });

      expect.soft(probes).toBe(0);
      expect.soft(readdirSync(homeRoot)).toEqual([]);
      if (kind === "symlink-parent" || kind === "dangling-file-symlink") {
        expect.soft(existsSync(reportPath)).toBe(false);
        expect.soft(existsSync(aliasPath)).toBe(false);
        if (kind === "dangling-file-symlink") {
          expect.soft(lstatSync(aliasPath).isSymbolicLink()).toBe(true);
        }
      } else {
        expect.soft(readFileSync(reportPath, "utf8")).toBe(sentinel);
        expect.soft(readFileSync(aliasPath, "utf8")).toBe(sentinel);
      }
    });

    it("rejects environment aliases before creating a temporary HOME", () => {
      if (process.platform !== "darwin" && process.platform !== "linux") {
        return;
      }

      const tempRoot = tempRoots.make("openclaw-startup-memory-admission-");
      const reportPath = path.join(tempRoot, "report");
      const blockedTempRoot = path.join(tempRoot, "not-a-directory");
      const sentinel = "existing report must survive admission\n";
      writeFileSync(reportPath, sentinel);
      writeFileSync(blockedTempRoot, "temporary HOME must not be attempted\n");
      let probes = 0;

      // A real ENOTDIR would win if temporary HOME creation preceded admission.
      withEnv(
        {
          OPENCLAW_STARTUP_MEMORY_JSON_PATH: reportPath,
          OPENCLAW_STARTUP_MEMORY_SUMMARY_PATH: reportPath,
          TMPDIR: blockedTempRoot,
          TEMP: blockedTempRoot,
          TMP: blockedTempRoot,
        },
        () => {
          expect
            .soft(() =>
              testing.runStartupMemoryCheck([], {
                platform: process.platform,
                spawnSync: () => {
                  probes += 1;
                  return {
                    status: 0,
                    signal: null,
                    stdout: "",
                    stderr: "__OPENCLAW_MAX_RSS_KB__=1024\n",
                  };
                },
              }),
            )
            .toThrow(aliasError);
        },
      );

      expect.soft(probes).toBe(0);
      expect.soft(readFileSync(reportPath, "utf8")).toBe(sentinel);
      expect
        .soft(readFileSync(blockedTempRoot, "utf8"))
        .toBe("temporary HOME must not be attempted\n");
      expect.soft(readdirSync(tempRoot).toSorted()).toEqual(["not-a-directory", "report"]);
    });

    it.each(["file", "file-symlink", "dangling-file-symlink"] as const)(
      "allows distinct report targets (%s)",
      (kind) => {
        if (process.platform !== "darwin" && process.platform !== "linux") {
          return;
        }

        const tempRoot = tempRoots.make("openclaw-startup-memory-distinct-");
        const jsonPath = path.join(tempRoot, "startup-memory.json");
        const summaryPath = path.join(tempRoot, "summary.md");
        const jsonTarget = kind === "file" ? jsonPath : path.join(tempRoot, "report-data");
        const sentinel = "identical bytes do not imply one file\n";
        if (kind !== "dangling-file-symlink") {
          writeFileSync(jsonTarget, sentinel);
        }
        if (kind !== "file") {
          symlinkSync(path.basename(jsonTarget), jsonPath, "file");
        }
        writeFileSync(summaryPath, sentinel);

        const result = runStartupMemoryCheckWithHelpSamples([1, 1, 1], tempRoot);

        expect(result.skipped).toBe(false);
        expect(result.results).toHaveLength(testing.cases.length);
        expect(JSON.parse(readFileSync(jsonTarget, "utf8"))).toMatchObject({
          status: "pass",
        });
        expect(readFileSync(summaryPath, "utf8")).toContain("# OpenClaw Startup Memory");
        expect(readFileSync(summaryPath, "utf8")).toContain("Status: pass");
        if (kind !== "file") {
          expect(lstatSync(jsonPath).isSymbolicLink()).toBe(true);
        }
      },
    );

    describe("physical symlink resolution", () => {
      function captureAdmissionFailure(args: string[], homeRoot: string) {
        let probes = 0;
        let failure: unknown;
        withEnv({ TMPDIR: homeRoot, TEMP: homeRoot, TMP: homeRoot }, () => {
          try {
            testing.runStartupMemoryCheck(args, {
              platform: process.platform,
              spawnSync: () => {
                probes += 1;
                return {
                  status: 0,
                  signal: null,
                  stdout: "",
                  stderr: "__OPENCLAW_MAX_RSS_KB__=1024\n",
                };
              },
            });
          } catch (error) {
            failure = error;
          }
        });
        return { probes, failure };
      }

      it.each([
        ["relative", false],
        ["relative", true],
        ["absolute", false],
        ["absolute", true],
      ] as const)(
        "rejects aliases through a %s raw target (reversed: %s)",
        (targetKind, reversed) => {
          if (process.platform !== "darwin" && process.platform !== "linux") {
            return;
          }

          const tempRoot = tempRoots.make("openclaw-startup-memory-physical-");
          const outside = path.join(tempRoot, "outside");
          const subdir = path.join(outside, "subdir");
          const homeRoot = path.join(tempRoot, "homes");
          mkdirSync(subdir, { recursive: true });
          mkdirSync(homeRoot);
          symlinkSync(subdir, path.join(tempRoot, "dir-link"), "dir");
          const leaf = path.join(tempRoot, "leaf");
          const target = path.join(outside, "report");
          // Keep ".." in the stored link: it applies after following dir-link.
          const relativeTarget = `dir-link${path.sep}..${path.sep}report`;
          const rawTarget =
            targetKind === "absolute" ? `${tempRoot}${path.sep}${relativeTarget}` : relativeTarget;
          symlinkSync(rawTarget, leaf, "file");
          const [jsonPath, summaryPath] = reversed ? [target, leaf] : [leaf, target];

          const result = captureAdmissionFailure(
            ["--json", jsonPath, "--summary", summaryPath],
            homeRoot,
          );

          expect.soft(result.failure).toMatchObject({ message: aliasError });
          expect.soft(result.probes).toBe(0);
          expect.soft(readdirSync(homeRoot)).toEqual([]);
          expect.soft(existsSync(target)).toBe(false);
          expect.soft(readlinkSync(leaf)).toBe(rawTarget);
        },
      );

      it("allows a distinct link chain whose lexical cycle keys collide", () => {
        if (process.platform !== "darwin" && process.platform !== "linux") {
          return;
        }

        const tempRoot = tempRoots.make("openclaw-startup-memory-link-chain-");
        const outside = path.join(tempRoot, "outside");
        const subdir = path.join(outside, "subdir");
        mkdirSync(subdir, { recursive: true });
        symlinkSync(subdir, path.join(tempRoot, "dir-link"), "dir");
        const jsonPath = path.join(tempRoot, "startup-memory.json");
        const secondLink = path.join(outside, "startup-memory.json");
        const target = path.join(outside, "report-data");
        const rawTarget = `dir-link${path.sep}..${path.sep}startup-memory.json`;
        symlinkSync(rawTarget, jsonPath, "file");
        symlinkSync("report-data", secondLink, "file");

        const result = runStartupMemoryCheckWithHelpSamples([1, 1, 1], tempRoot);

        expect(result.skipped).toBe(false);
        expect(result.results).toHaveLength(testing.cases.length);
        expect(JSON.parse(readFileSync(target, "utf8"))).toMatchObject({ status: "pass" });
        expect(readFileSync(path.join(tempRoot, "summary.md"), "utf8")).toContain("Status: pass");
        expect(readlinkSync(jsonPath)).toBe(rawTarget);
        expect(readlinkSync(secondLink)).toBe("report-data");
      });

      it("rejects a genuine symlink cycle before probing", () => {
        if (process.platform !== "darwin" && process.platform !== "linux") {
          return;
        }

        const tempRoot = tempRoots.make("openclaw-startup-memory-link-cycle-");
        const homeRoot = path.join(tempRoot, "homes");
        mkdirSync(homeRoot);
        const jsonPath = path.join(tempRoot, "first-link");
        const secondLink = path.join(tempRoot, "second-link");
        const summaryPath = path.join(tempRoot, "summary.md");
        const sentinel = "existing summary must survive admission\n";
        symlinkSync("second-link", jsonPath, "file");
        symlinkSync("first-link", secondLink, "file");
        writeFileSync(summaryPath, sentinel);

        const result = captureAdmissionFailure(
          ["--json", jsonPath, "--summary", summaryPath],
          homeRoot,
        );

        expect.soft(result.failure).toMatchObject({ code: "ELOOP" });
        expect.soft(result.probes).toBe(0);
        expect.soft(readdirSync(homeRoot)).toEqual([]);
        expect.soft(readFileSync(summaryPath, "utf8")).toBe(sentinel);
        expect.soft(readlinkSync(jsonPath)).toBe("second-link");
        expect.soft(readlinkSync(secondLink)).toBe("first-link");
      });
    });
  });

  it("does not create a temp home before argument validation succeeds", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    const result = spawnSync(process.execPath, ["scripts/check-cli-startup-memory.mjs", "--json"], {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: tempRoot,
        TEMP: tempRoot,
        TMP: tempRoot,
      },
    });

    expect(result.status).not.toBe(0);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  it("reports CLI argument errors without a Node stack trace", () => {
    const result = spawnSync(process.execPath, ["scripts/check-cli-startup-memory.mjs", "--wat"], {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Unknown option: --wat");
    expectNoNodeStack(result.stderr);
  });

  it("times out startup probes instead of hanging indefinitely", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    const seenTimeouts: Array<number | undefined> = [];
    const seenKillSignals: Array<string | undefined> = [];
    const timeoutError = Object.assign(new Error("spawnSync timed out"), { code: "ETIMEDOUT" });

    expect(() =>
      testing.runStartupMemoryCheck(
        [
          "--json",
          path.join(tempRoot, "startup-memory.json"),
          "--summary",
          path.join(tempRoot, "summary.md"),
        ],
        {
          platform: "linux",
          timeoutMs: 1234,
          spawnSync: (
            _command: string,
            _args: string[],
            options: { killSignal?: string; timeout?: number },
          ) => {
            seenTimeouts.push(options.timeout);
            seenKillSignals.push(options.killSignal);
            return {
              error: timeoutError,
              signal: "SIGKILL",
              status: null,
              stderr: "",
              stdout: "",
            };
          },
        },
      ),
    ).toThrow("--help timed out after 1234ms");
    expect(seenTimeouts).toEqual(testing.cases.map(() => 1234));
    expect(seenKillSignals).toEqual(testing.cases.map(() => "SIGKILL"));
  });

  it("rejects zero RSS markers instead of passing empty resource evidence", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    expect(() =>
      testing.runStartupMemoryCheck(
        [
          "--json",
          path.join(tempRoot, "startup-memory.json"),
          "--summary",
          path.join(tempRoot, "summary.md"),
        ],
        {
          platform: "darwin",
          spawnSync: () => ({
            signal: null,
            status: 0,
            stderr: "__OPENCLAW_MAX_RSS_KB__=0\n",
            stdout: "",
          }),
        },
      ),
    ).toThrow("--help did not report max RSS");
  });

  it("passes the generated RSS hook as a Node import URL", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      return;
    }

    const tempRoot = tempRoots.make("openclaw-startup-memory-test-");
    const seenArgs: string[][] = [];
    const seenHomes: string[] = [];

    const result = testing.runStartupMemoryCheck(
      [
        "--json",
        path.join(tempRoot, "startup-memory.json"),
        "--summary",
        path.join(tempRoot, "summary.md"),
      ],
      {
        platform: "linux",
        spawnSync: (_command: string, args: string[], options: { env: Record<string, string> }) => {
          seenArgs.push(args);
          const home = options.env.HOME;
          if (!home) {
            throw new Error("benchmark HOME was not set");
          }
          seenHomes.push(home);
          return {
            error: null,
            signal: null,
            status: 0,
            stderr: "__OPENCLAW_MAX_RSS_KB__=1024\n",
            stdout: "",
          };
        },
      },
    );

    expect(result.skipped).toBe(false);
    expect(seenArgs).toHaveLength(testing.cases.length * testing.sampleCount);
    expect(new Set(seenHomes).size).toBe(seenArgs.length);
    for (const args of seenArgs) {
      // The bench entry runs the launcher in-process instead of preloading an
      // --import hook, which would disable the dist ESM resolve fast path and
      // measure a non-default resolution configuration.
      expect(args[0]).toMatch(/bench-entry\.mjs$/u);
      expect(args[0]).not.toBe("--import");
      expect(args[1]).not.toBe("openclaw.mjs");
    }
  });
});
