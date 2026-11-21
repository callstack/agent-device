import type { CliFlags } from '@agent-device/contracts/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { exitBeforeCommand } from './pre-command-failure.ts';

type LoginTimingContext = {
  command: string;
  positionals: readonly string[];
  /** The run's flags, after every source that can carry one was resolved. */
  flags: CliFlags;
};

/**
 * What the CLI answers about a `connect` before it runs that command: whether the command holds its
 * login, and whether the provider it names is already refused. Both are answered from the plugin
 * admission owner, which loads only when a `connect` needs it.
 */
const connectAdmission = () => import('./connection/provider-admission.ts');

/** Whether this run holds its login until the provider it discovers is admitted. */
export async function defersLoginUntilProviderAdmission(
  context: LoginTimingContext,
): Promise<boolean> {
  if (context.command !== 'connect') return false;
  const { defersConnectLogin } = await connectAdmission();
  return defersConnectLogin(context);
}

/** Refuses a provider `connect` names before this run reads a credential, or goes on to its parse. */
export async function admitConnectProviderOrExit(
  argv: readonly string[],
  host: HostEnvironment,
  options: { jsonRequested: boolean; debugEnabled: boolean },
): Promise<void> {
  const { admitConnectProviderNamedInArguments } = await connectAdmission();
  try {
    await admitConnectProviderNamedInArguments(argv, host);
  } catch (error) {
    await exitBeforeCommand(error, [...argv], options, 'cli_plugin_refused');
  }
}
