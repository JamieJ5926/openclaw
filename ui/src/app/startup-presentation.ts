import { createContext } from "@lit/context";

export type StartupPresentation = {
  stage: "pending" | "chrome" | "ready";
  placeholderVisible: boolean;
};

export const READY_STARTUP_PRESENTATION: StartupPresentation = {
  stage: "ready",
  placeholderVisible: false,
};
export const startupPresentationContext = createContext<StartupPresentation>(
  "openclaw-startup-presentation",
);

/** One document owns initial feedback; reconnects and background loads never rearm it. */
export class StartupPresentationController {
  snapshot: StartupPresentation = READY_STARTUP_PRESENTATION;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chromeReady = false;
  private contentReady = false;
  private shownAt: number | undefined;

  constructor(private readonly publish: (snapshot: StartupPresentation) => void) {}

  start() {
    this.dispose();
    this.chromeReady = false;
    this.contentReady = false;
    this.shownAt = undefined;
    this.set({ stage: "pending", placeholderVisible: false });
    this.showAfterDelay();
  }

  private showAfterDelay() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.shownAt = performance.now();
      this.set({ ...this.snapshot, placeholderVisible: true });
      this.advance();
    }, 150);
  }

  update(chromeReady: boolean, contentReady: boolean) {
    this.chromeReady ||= chromeReady;
    this.contentReady ||= contentReady;
    this.advance();
  }

  finish() {
    this.dispose();
    this.set(READY_STARTUP_PRESENTATION);
  }

  dispose() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private set(snapshot: StartupPresentation) {
    this.snapshot = snapshot;
    this.publish(snapshot);
  }

  private advance() {
    const { stage } = this.snapshot;
    if (stage === "ready" || !this.chromeReady || (stage === "chrome" && !this.contentReady)) {
      return;
    }
    const remaining = this.shownAt === undefined ? 0 : this.shownAt + 300 - performance.now();
    if (remaining > 0) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.advance();
      }, remaining);
      return;
    }
    if (this.contentReady) {
      this.finish();
      return;
    }
    // History can finish just after the chrome mounts. Start its feedback delay
    // at this visible boundary so fast history never flashes a placeholder.
    this.shownAt = undefined;
    this.set({ stage: "chrome", placeholderVisible: false });
    this.showAfterDelay();
  }
}
