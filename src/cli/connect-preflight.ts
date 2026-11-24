import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { asAppError } from '@agent-device/kernel/errors';
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
    const { runCloudCatalog } = await import('./connection/cloud-catalog.ts');
    await runCloudCatalog(catalog, host);
    return true;
  } catch (error) {
    return await exitBeforeCommand(error, [...argv], options, 'cli_cloud_catalog_failed');
  }
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
