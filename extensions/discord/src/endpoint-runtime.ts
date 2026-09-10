// Discord plugin module owns trusted, process-local endpoint routing.
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  fetchWithSsrFGuard,
  isBlockedHostnameOrIp,
  isLoopbackHost,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";

const DISCORD_ENDPOINT_DESCRIPTOR_MAX_BYTES = 8 * 1024;
const DISCORD_ENDPOINT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

export type DiscordEndpointDescriptor = Readonly<{
  /** Complete, versioned REST base, for example https://discord.com/api/v10. */
  restApiBaseUrl: string;
  /** Exact authenticated Gateway metadata endpoint. */
  gatewayBotUrl: string;
  /** Exact WebSocket origin accepted for initial and resumed Gateway sockets. */
  gatewayOrigin: string;
}>;

export type DiscordEndpointRuntime = Readonly<{
  descriptor: DiscordEndpointDescriptor;
  fetch: typeof fetch;
  /** Aborts when the trusted host retires this endpoint generation. */
  signal: AbortSignal;
  /** Rejects retained work after close or replacement. */
  assertActive: () => void;
}>;

export type DiscordEndpointLease = Readonly<{
  runtime: DiscordEndpointRuntime;
  /** Revokes retained transports and aborts in-flight work for this generation. */
  close: () => void;
}>;

type DiscordEndpointLeaseState = {
  active: boolean;
  abortController: AbortController;
  owner: symbol;
};

let activeEndpoint:
  | Readonly<{ state: DiscordEndpointLeaseState; runtime: DiscordEndpointRuntime }>
  | undefined;

function assertEndpointLeaseActive(state: DiscordEndpointLeaseState): void {
  if (!state.active || activeEndpoint?.state !== state) {
    throw new Error("Discord endpoint runtime lease has been retired");
  }
}

function parseHttpAnchor(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new Error(`${label} must use HTTPS or loopback HTTP`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(`${label} must not contain credentials or a fragment`);
  }
  return url;
}

function normalizeRestApiBaseUrl(value: string): URL {
  const url = parseHttpAnchor(value, "Discord endpoint REST API base URL");
  if (url.search) {
    throw new Error("Discord endpoint REST API base URL must not contain a query");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url;
}

function normalizeGatewayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Discord endpoint Gateway origin must be a valid URL");
  }
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopbackHost(url.hostname))) {
    throw new Error("Discord endpoint Gateway origin must use WSS or loopback WS");
  }
  if (url.protocol === "wss:" && isBlockedHostnameOrIp(url.hostname)) {
    throw new Error(
      "Discord endpoint Gateway origin must not target a private/internal/special-use hostname or IP address",
    );
  }
  if (url.username || url.password || url.hash || url.pathname !== "/" || url.search) {
    throw new Error(
      "Discord endpoint Gateway origin must be an origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

function normalizeDescriptor(descriptor: DiscordEndpointDescriptor): DiscordEndpointDescriptor {
  const rawBytes = Object.values(descriptor).reduce(
    (total, value) => total + Buffer.byteLength(value, "utf8"),
    0,
  );
  if (rawBytes > DISCORD_ENDPOINT_DESCRIPTOR_MAX_BYTES) {
    throw new Error(
      `Discord endpoint descriptor exceeds ${DISCORD_ENDPOINT_DESCRIPTOR_MAX_BYTES} aggregate bytes`,
    );
  }
  const restApiBaseUrl = normalizeRestApiBaseUrl(descriptor.restApiBaseUrl.trim());
  const gatewayBotUrl = parseHttpAnchor(
    descriptor.gatewayBotUrl.trim(),
    "Discord endpoint Gateway metadata URL",
  );
  return Object.freeze({
    restApiBaseUrl: restApiBaseUrl.toString().replace(/\/$/u, ""),
    gatewayBotUrl: gatewayBotUrl.toString(),
    gatewayOrigin: normalizeGatewayOrigin(descriptor.gatewayOrigin.trim()),
  });
}

function isWithinRestApiBase(target: URL, restApiBaseUrl: URL): boolean {
  if (target.origin !== restApiBaseUrl.origin) {
    return false;
  }
  const basePath = restApiBaseUrl.pathname.replace(/\/+$/u, "");
  return (
    basePath === "" || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`)
  );
}

function assertEndpointHttpTarget(target: URL, descriptor: DiscordEndpointDescriptor): void {
  const restApiBaseUrl = new URL(descriptor.restApiBaseUrl);
  const gatewayBotUrl = new URL(descriptor.gatewayBotUrl);
  if (
    !isWithinRestApiBase(target, restApiBaseUrl) &&
    target.toString() !== gatewayBotUrl.toString()
  ) {
    throw new Error("Discord endpoint request is outside the configured boundaries");
  }
}

function requestInitFromRequest(request: Request, signal: AbortSignal): RequestInit {
  const rawDuplex: unknown = Reflect.get(request, "duplex");
  return {
    method: request.method,
    headers: request.headers,
    ...(request.body
      ? { body: request.body, ...(rawDuplex === "half" ? { duplex: "half" as const } : {}) }
      : {}),
    signal,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  };
}

function createEndpointFetch(
  descriptor: DiscordEndpointDescriptor,
  state: DiscordEndpointLeaseState,
): typeof fetch {
  const allowedOrigins = Array.from(
    new Set([new URL(descriptor.restApiBaseUrl).origin, new URL(descriptor.gatewayBotUrl).origin]),
  );
  return async (input, init) => {
    assertEndpointLeaseActive(state);
    const request = new Request(input, init);
    const target = new URL(request.url);
    assertEndpointHttpTarget(target, descriptor);
    const signal = AbortSignal.any([request.signal, state.abortController.signal]);
    // Revalidate at the final synchronous boundary before guarded DNS/network work.
    assertEndpointLeaseActive(state);
    const guarded = await fetchWithSsrFGuard({
      url: target.toString(),
      init: requestInitFromRequest(request, signal),
      signal,
      requireHttps: target.protocol === "https:",
      policy: { allowedOrigins },
      maxRedirects: 0,
      capture: false,
      auditContext: "discord.endpoint-runtime",
    });
    try {
      const body = await readResponseWithLimit(
        guarded.response,
        DISCORD_ENDPOINT_RESPONSE_MAX_BYTES,
        {
          onOverflow: ({ size, maxBytes }) =>
            new Error(
              `Discord endpoint response too large: ${size} bytes (limit: ${maxBytes} bytes)`,
            ),
        },
      );
      return new Response(body.byteLength > 0 ? new Uint8Array(body) : null, {
        status: guarded.response.status,
        statusText: guarded.response.statusText,
        headers: guarded.response.headers,
      });
    } finally {
      await guarded.release();
    }
  };
}

/**
 * Install a process-wide Discord endpoint only from a trusted in-process host boundary.
 *
 * While installed, the descriptor takes precedence over Discord proxy routing for all supported
 * network surfaces. Interactive voice transport is unavailable in this mode. The host must close
 * the lease during shutdown before installing another generation; close aborts in-flight work and
 * revokes retained transports. This capability is intentionally absent from public configuration
 * and environment variables.
 */
export function installDiscordEndpointRuntime(
  descriptor: DiscordEndpointDescriptor,
): DiscordEndpointLease {
  if (activeEndpoint) {
    throw new Error("Discord endpoint runtime is already installed");
  }
  const normalized = normalizeDescriptor(descriptor);
  const state: DiscordEndpointLeaseState = {
    active: true,
    abortController: new AbortController(),
    owner: Symbol("discord-endpoint-runtime-owner"),
  };
  const runtime = Object.freeze({
    descriptor: normalized,
    fetch: createEndpointFetch(normalized, state),
    signal: state.abortController.signal,
    assertActive: () => assertEndpointLeaseActive(state),
  });
  activeEndpoint = { state, runtime };
  return Object.freeze({
    runtime,
    close() {
      if (!state.active) {
        return;
      }
      state.active = false;
      state.abortController.abort(new Error("Discord endpoint runtime lease has been retired"));
      if (activeEndpoint?.state === state) {
        activeEndpoint = undefined;
      }
    },
  });
}

export function getDiscordEndpointRuntime(): DiscordEndpointRuntime | undefined {
  return activeEndpoint?.runtime;
}

export function assertDiscordEndpointRuntimeActive(runtime: DiscordEndpointRuntime): void {
  runtime.assertActive();
}

export function resolveDiscordEndpointMediaGuard(
  url: string,
  retainedRuntime?: DiscordEndpointRuntime | null,
): Readonly<{ maxRedirects: 0; ssrfPolicy: SsrFPolicy }> | undefined {
  if (retainedRuntime === null) {
    return undefined;
  }
  const runtime = retainedRuntime ?? getDiscordEndpointRuntime();
  if (!runtime) {
    return undefined;
  }
  runtime.assertActive();
  const target = parseHttpAnchor(url, "Discord endpoint media URL");
  const restOrigin = new URL(runtime.descriptor.restApiBaseUrl).origin;
  if (target.origin !== restOrigin) {
    throw new Error("Discord endpoint media URL is outside the configured REST origin");
  }
  return {
    maxRedirects: 0,
    ssrfPolicy: { allowedOrigins: [restOrigin], hostnameAllowlist: [target.hostname] },
  };
}

export function resolveDiscordEndpointAttachmentGuard(
  url: string,
  retainedRuntime?: DiscordEndpointRuntime | null,
): Readonly<{ maxRedirects: 0; policy: SsrFPolicy; requireHttps: boolean }> | undefined {
  if (retainedRuntime === null) {
    return undefined;
  }
  const runtime = retainedRuntime ?? getDiscordEndpointRuntime();
  if (!runtime) {
    return undefined;
  }
  runtime.assertActive();
  const target = parseHttpAnchor(url, "Discord endpoint attachment upload URL");
  const restOrigin = new URL(runtime.descriptor.restApiBaseUrl).origin;
  if (target.origin !== restOrigin) {
    throw new Error("Discord endpoint attachment upload URL is outside the configured REST origin");
  }
  return {
    maxRedirects: 0,
    policy: { allowedOrigins: [restOrigin], hostnameAllowlist: [target.hostname] },
    requireHttps: target.protocol === "https:",
  };
}

export function assertDiscordEndpointGatewayUrl(url: string, gatewayOrigin?: string): void {
  if (!gatewayOrigin) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Discord endpoint returned an invalid Gateway WebSocket URL");
  }
  if (parsed.origin !== gatewayOrigin || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Discord endpoint Gateway URL is outside the configured WebSocket origin");
  }
}
