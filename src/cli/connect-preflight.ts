import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { exitBeforeCommand } from './pre-command-failure.ts';

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
    await exitBeforeCommand(error, [...argv], options, 'cli_plugin_refused');
  }
}
