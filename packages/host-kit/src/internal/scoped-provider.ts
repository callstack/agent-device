import { AsyncLocalStorage } from 'node:async_hooks';

export type ScopedProvider<TProvider, TInput = TProvider> = {
  resolve(input?: TInput): TProvider;
  run<TResult>(input: TInput | undefined, fn: () => Promise<TResult>): Promise<TResult>;
  hasScope(): boolean;
};

export function createScopedProvider<TProvider, TInput = TProvider>(
  localProvider: TProvider,
  normalize: (input: TInput) => TProvider = (input) => input as unknown as TProvider,
): ScopedProvider<TProvider, TInput> {
  const storage = new AsyncLocalStorage<TProvider>();

  return {
    resolve(input) {
      return input ? normalize(input) : (storage.getStore() ?? localProvider);
    },
    async run(input, fn) {
      if (!input) return await fn();
      return await storage.run(normalize(input), fn);
    },
    hasScope() {
      return Boolean(storage.getStore());
    },
  };
}
