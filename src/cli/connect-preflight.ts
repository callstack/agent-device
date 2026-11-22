import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { asAppError } from '@agent-device/kernel/errors';
import { exitBeforeCommand } from './pre-command-failure.ts';

const PLUGIN_REFUSAL_PHASE = 'cli_plugin_refused';

/** Refuses a provider `connect` names before this run reads a credential, or goes on to its parse. */
export async function admitConnectProviderOrExit(
  argv: readonly string[],
  host: HostEnvironment,
  options: { jsonRequested: boolean; debugEnabled: boolean },
): Promise<void> {
  const { admitConnectProviderNamedInArguments } =
    await import('./connection/provider-admission.ts');
  try {
    await admitConnectProviderNamedInArguments(argv, host);
  } catch (error) {
    await exitBeforeCommand(error, [...argv], options, PLUGIN_REFUSAL_PHASE);
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
