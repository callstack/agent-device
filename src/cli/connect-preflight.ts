import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { AppError, asAppError } from '@agent-device/kernel/errors';
import type { parseRawArgs } from './parser/args.ts';
import { exitBeforeCommand } from './pre-command-failure.ts';

const PLUGIN_REFUSAL_PHASE = 'cli_plugin_refused';

/** Refuses a provider `connect` names before this run reads a credential, or goes on to its parse. */
export async function runConnectPreflight(
  argv: readonly string[],
  host: HostEnvironment,
  options: { jsonRequested: boolean; debugEnabled: boolean },
): Promise<boolean> {
  const { preflightConnect } = await import('./connection/provider-admission.ts');
  let catalog;
  try {
    catalog = await preflightConnect(argv, host);
  } catch (error) {
    return await exitBeforeCommand(error, [...argv], options, PLUGIN_REFUSAL_PHASE);
  }
  if (!catalog) return false;
  try {
    await runCatalogPreflight(catalog, host);
    return true;
  } catch (error) {
    return await exitBeforeCommand(error, [...argv], options, 'cli_cloud_catalog_failed');
  }
}

async function runCatalogPreflight(
  input: ReturnType<typeof parseRawArgs>,
  host: HostEnvironment,
): Promise<void> {
  const { command, positionals, flags, providedFlags } = input;
  if (positionals.length !== (positionals[1] === 'list' ? 2 : 1)) {
    throw new AppError('INVALID_ARGS', 'A catalog listing accepts no additional arguments.');
  }
  const allowed = ['config', 'stateDir', 'live', 'json'];
  const invalid = providedFlags.find(({ key }) => !allowed.includes(key));
  if (invalid) {
    throw new AppError('INVALID_ARGS', `${invalid.token} is unavailable for a catalog listing.`);
  }
  const { resolveConfigDefaults } = await import('@agent-device/command-surface');
  const { admitDaemonStateRoot, resolveDaemonPaths } =
    await import('@agent-device/daemon-contracts/daemon-resolution');
  const defaults = resolveConfigDefaults({
    command,
    cwd: host.cwd,
    cliFlags: flags,
    env: host.env,
  });
  const paths = resolveDaemonPaths(flags.stateDir ?? defaults.flags.stateDir, host);
  admitDaemonStateRoot({ paths, mode: 'repair', refuseWritableRoot: true });
  const { runCloudCatalog } = await import('./connection/cloud-catalog.ts');
  await runCloudCatalog({
    stateDir: paths.baseDir,
    env: host.env,
    live: flags.live,
    json: flags.json,
  });
}

export async function admitConnectProfileWithDiagnostics(
  provider: string | undefined,
  daemonBaseUrl: string | undefined,
  host: HostEnvironment,
): Promise<void> {
  const { admitConnectProfileProvider } = await import('./connection/provider-admission.ts');
  try {
    await admitConnectProfileProvider(provider, daemonBaseUrl, host);
  } catch (error) {
    emitDiagnostic({
      level: 'error',
      phase: PLUGIN_REFUSAL_PHASE,
      data: { error: asAppError(error).message },
    });
    throw error;
  }
}
