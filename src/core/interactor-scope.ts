import type { Interactor } from './interactor-types.ts';

/**
 * Wraps every interactor method call in a provider transport scope, so leaf
 * code below the method resolves the injected transport instead of the local
 * default. Shared by the Android adb-provider and Apple runner-provider seams.
 */
export function withProviderScopedInteractor(
  interactor: Interactor,
  runScope: <T>(task: () => Promise<T>) => Promise<T>,
): Interactor {
  return new Proxy(interactor, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => runScope(async () => await value.apply(target, args));
    },
  });
}
