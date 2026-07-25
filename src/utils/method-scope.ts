/**
 * Wraps every method call on `target` in `runScope`, so leaf code below the
 * method resolves scope-injected state (AsyncLocalStorage transports) instead
 * of the local default. Shared by the Android adb-provider and Apple
 * runner-provider interactor seams.
 */
export function withMethodScope<T extends object>(
  target: T,
  runScope: <R>(task: () => Promise<R>) => Promise<R>,
): T {
  return new Proxy(target, {
    get(proxyTarget, property, receiver) {
      const value = Reflect.get(proxyTarget, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => runScope(async () => await value.apply(proxyTarget, args));
    },
  });
}
