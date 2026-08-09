/** One cleanup transaction shared by request scopes and platform bind rollback. */
export class AsyncCleanupStack implements AsyncDisposable {
  readonly #cleanups: Array<() => Promise<void>> = [];
  #state: 'open' | 'disposing' | 'disposed' = 'open';

  get disposed(): boolean {
    return this.#state === 'disposed';
  }

  defer(cleanup: () => Promise<void>): void {
    this.#assertOpen();
    this.#cleanups.push(cleanup);
  }

  use<Value extends AsyncDisposable>(value: Value): Value {
    this.defer(async () => await value[Symbol.asyncDispose]());
    return value;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#state === 'disposed') return;
    if (this.#state === 'disposing') {
      throw new TypeError('Async cleanup stack disposal is already in progress');
    }
    this.#state = 'disposing';
    const failures: unknown[] = [];
    while (this.#cleanups.length > 0) {
      const cleanup = this.#cleanups.pop();
      if (!cleanup) continue;
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#state = 'disposed';
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Multiple asynchronous cleanups failed');
    }
  }

  #assertOpen(): void {
    if (this.#state !== 'open') {
      throw new TypeError('Cannot register cleanup after disposal has begun');
    }
  }
}

/**
 * Owns a newly published handle until command orchestration adopts it exactly once.
 * Disposing a transferred guard is inert; disposing a pending guard cleans the handle.
 */
export class PendingTransferGuard<Value extends AsyncDisposable> implements AsyncDisposable {
  readonly #value: Value;
  #state: 'pending' | 'transferred' | 'disposed' = 'pending';

  constructor(value: Value) {
    this.#value = value;
  }

  get pending(): boolean {
    return this.#state === 'pending';
  }

  transfer(): Value {
    if (this.#state !== 'pending') {
      throw new TypeError(`Cannot transfer handle in ${this.#state} state`);
    }
    this.#state = 'transferred';
    return this.#value;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#state !== 'pending') return;
    this.#state = 'disposed';
    await this.#value[Symbol.asyncDispose]();
  }
}
