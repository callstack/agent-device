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

  async wait(key: string): Promise<void> {
    if (!this.active.has(key)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.waiters.get(key) ?? new Set<() => void>();
      waiters.add(resolve);
      this.waiters.set(key, waiters);
    });
  }
}
