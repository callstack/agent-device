export class DeviceMutationDrain {
  private readonly active = new Map<string, number>();
  private readonly waiters = new Map<string, Set<() => void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      return await task();
    } finally {
      const remaining = (this.active.get(key) ?? 1) - 1;
      if (remaining > 0) {
        this.active.set(key, remaining);
      } else {
        this.active.delete(key);
        const waiters = this.waiters.get(key);
        this.waiters.delete(key);
        for (const resolve of waiters ?? []) resolve();
      }
    }
  }

  async wait(key: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!this.active.has(key)) return;
    const waiters = this.waiters.get(key) ?? new Set<() => void>();
    let drained: () => void = () => {};
    let aborted: () => void = () => {};
    try {
      await new Promise<void>((resolve, reject) => {
        drained = resolve;
        aborted = () => reject(signal?.reason);
        waiters.add(drained);
        this.waiters.set(key, waiters);
        signal?.addEventListener('abort', aborted, { once: true });
      });
    } finally {
      signal?.removeEventListener('abort', aborted);
      waiters.delete(drained);
      if (waiters.size === 0 && this.waiters.get(key) === waiters) this.waiters.delete(key);
    }
  }
}
