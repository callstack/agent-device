import path from 'node:path';

/**
 * The two ports one Vega executable lookup needs — the host `PATH`, and a host home to probe — so
 * inventory, doctor and the CLI adapter all resolve through one resolver over the host they were
 * bound to (#3794). A host that names no home omits `homeDirectory`; then the default-install probe
 * is skipped, never guessed from the process (#3753).
 */
export type VegaExecutableHost = Readonly<{
  which: (executable: string) => Promise<string | undefined>;
  isExecutableFile: (candidate: string) => Promise<boolean>;
  homeDirectory: string | undefined;
}>;

/** One lookup: PATH first, then the host home's default install, else nothing. */
export function resolveVegaExecutable(host: VegaExecutableHost): Promise<string | undefined> {
  return lookupVegaExecutable(host);
}

async function lookupVegaExecutable(host: VegaExecutableHost): Promise<string | undefined> {
  if (await host.which('vega')) return 'vega';
  if (host.homeDirectory === undefined) return undefined;
  const defaultInstall = vegaDefaultInstallPath(host.homeDirectory);
  return (await host.isExecutableFile(defaultInstall)) ? defaultInstall : undefined;
}

/** The default install the resolver probes, in the order the plugin's own guidance names it. */
export function vegaDefaultInstallPath(homeDirectory: string): string {
  return path.join(homeDirectory, 'vega', 'bin', 'vega');
}
