import { ShutdownError } from '../errors.js';

/**
 * Graceful shutdown. Work is registered with track(); once shutdown starts,
 * new work is refused with ShutdownError and drain() waits (bounded) for the
 * in-flight work to finish, so a job's state is never left half-written.
 */
export class ShutdownController {
  private shuttingDown = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly onShutdown: Array<() => void | Promise<void>> = [];

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Throws ShutdownError if shutdown has started; call at the top of any loop iteration. */
  assertRunning(): void {
    if (this.shuttingDown) throw new ShutdownError();
  }

  /** Registers async work. Refuses new work once shutting down. */
  async track<T>(work: () => Promise<T>): Promise<T> {
    this.assertRunning();
    const promise = work();
    this.inFlight.add(promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(promise);
    }
  }

  /** Registers a cleanup hook (e.g. close a browser) to run once on shutdown. */
  register(hook: () => void | Promise<void>): void {
    this.onShutdown.push(hook);
  }

  /**
   * Starts shutdown, waits up to `timeoutMs` for in-flight work, then runs the
   * cleanup hooks. Resolves to true if everything drained in time.
   * Safe to call more than once.
   */
  async shutdown(timeoutMs = 30_000): Promise<boolean> {
    this.shuttingDown = true;
    const settled = Promise.allSettled([...this.inFlight]).then(() => true);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = await Promise.race([settled, timedOut]);
    if (timer) clearTimeout(timer);
    const hooks = this.onShutdown.splice(0);
    await Promise.allSettled(hooks.map((h) => Promise.resolve().then(h)));
    return drained;
  }

  /** Wires SIGINT/SIGTERM to shutdown(). Returns a function that removes the handlers. */
  installSignalHandlers(proc: Pick<NodeJS.Process, 'on' | 'off'> = process, timeoutMs = 30_000): () => void {
    const handler = () => {
      void this.shutdown(timeoutMs);
    };
    proc.on('SIGINT', handler);
    proc.on('SIGTERM', handler);
    return () => {
      proc.off('SIGINT', handler);
      proc.off('SIGTERM', handler);
    };
  }
}
