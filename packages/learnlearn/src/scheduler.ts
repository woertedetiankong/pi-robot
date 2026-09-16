export const CARD_TIMEOUT_MS = 180_000;
export class RequestTimeoutError extends Error {
  constructor() { super("请求超时，请稍后重试"); this.name = "RequestTimeoutError"; }
}

/** A latest-generation gate. Cancellation releases UI state immediately even if a provider ignores abort. */
export class RequestGate {
  private current?: { controller: AbortController; token: number };
  private serial = 0;
  get busy(): boolean { return !!this.current; }
  cancel(): void { const old = this.current; this.current = undefined; this.serial++; old?.controller.abort(); }
  async run<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = 45000): Promise<T | undefined> {
    if (this.current) return undefined;
    const controller = new AbortController(), token = ++this.serial;
    this.current = { controller, token };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("请求已取消")), { once: true });
      timer = setTimeout(() => { reject(new RequestTimeoutError()); controller.abort(); }, timeoutMs);
      timer.unref?.();
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => work(controller.signal)), cancelled]);
      return this.serial === token && !controller.signal.aborted ? value : undefined;
    } catch (e) {
      if (this.serial !== token) return undefined;
      throw e;
    } finally {
      clearTimeout(timer);
      if (this.current?.token === token) this.current = undefined;
    }
  }
}
