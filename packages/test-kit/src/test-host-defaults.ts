const providedDefaults = new Map<string, unknown>();

/**
 * Registers the real host capabilities one package's suites take as their overridable defaults, under
 * the key the package's own test setup reads them back with. A package that cannot import the module
 * that builds its host (the host's owner depends on the package) gets the real host this way: the
 * owner's setup file provides it and the package's setup file requires it.
 */
export function provideTestHostDefaults<Host>(key: string, host: Host): void {
  providedDefaults.set(key, host);
}

export function requireTestHostDefaults<Host>(key: string): Host {
  if (!providedDefaults.has(key)) {
    throw new Error(
      `No test host defaults were provided for "${key}"; list the owner's setup file before the package's.`,
    );
  }
  return providedDefaults.get(key) as Host;
}
