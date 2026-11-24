const hostedBearers = new Set<ReadonlySet<string>>();
let restoreFetch: (() => void) | undefined;

/** The pinned SDK uses global fetch from its private proxy transport and has no fetch option. */
export function refuseHostedInstanceRedirects(tokens: readonly string[]): () => void {
  const bearers = new Set(tokens.map((token) => `Bearer ${token}`));
  hostedBearers.add(bearers);
  if (!restoreFetch) {
    const baseFetch = globalThis.fetch;
    const fetchWithPolicy: typeof baseFetch = async (input, init) => {
      const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
      const authorization = new Headers(headers).get('authorization');
      const isHosted =
        authorization && [...hostedBearers].some((entry) => entry.has(authorization));
      return await baseFetch(input, isHosted ? { ...init, redirect: 'error' } : init);
    };
    globalThis.fetch = fetchWithPolicy;
    restoreFetch = () => {
      if (globalThis.fetch === fetchWithPolicy) globalThis.fetch = baseFetch;
      restoreFetch = undefined;
    };
  }
  return () => {
    hostedBearers.delete(bearers);
    if (!hostedBearers.size) restoreFetch?.();
  };
}
