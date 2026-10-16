import type { MetroSessionOptions, MetroSessionOpenInput } from './metro/metro-session-hints.ts';
import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import { resolveRuntimeTransportHints } from '@agent-device/host-kit/runtime-transport-hints';
import type { PrepareMetroRuntimeOptions, ReloadMetroOptions } from './metro/client-metro.ts';
import type { PrepareMetroRuntimeResult, ReloadMetroResult } from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import type { ReactDevtoolsCommandOptions } from './react-devtools/react-devtools-connection.ts';
import type { ReactDevtoolsOutput } from './react-devtools/react-devtools-output.ts';

export type { PrepareMetroRuntimeOptions, ReloadMetroOptions } from './metro/client-metro.ts';
export type { PrepareMetroRuntimeResult, ReloadMetroResult } from '@agent-device/contracts/remote';
export type { MetroBridgeDescriptor } from './metro/metro-types.ts';
export type { ReactDevtoolsCommandOptions } from './react-devtools/react-devtools-connection.ts';
export type { ReactDevtoolsOutput } from './react-devtools/react-devtools-output.ts';
export type { MetroSessionOptions, MetroSessionOpenInput } from './metro/metro-session-hints.ts';

export type StopMetroTunnelOptions = {
  projectRoot: string;
  profileKey?: string;
  consumerKey?: string;
};

export { normalizeBaseUrl } from './metro/base-url.ts';
export { buildBundleUrl } from './metro/bundle-url.ts';
export type {
  MetroTunnelRequestMessage,
  MetroTunnelResponseMessage,
} from './companion/metro-tunnel-messages.ts';

export function resolveRuntimeTransport(
  runtime: SessionRuntimeHints | undefined,
): { host: string; port: number; scheme: 'http' | 'https' } | undefined {
  return resolveRuntimeTransportHints(runtime);
}

export async function prepareMetroRuntime(
  input: PrepareMetroRuntimeOptions = {},
): Promise<PrepareMetroRuntimeResult> {
  const runtime = await import('./metro/client-metro.ts');
  return await runtime.prepareMetroRuntime(input);
}

export async function reloadMetro(input: ReloadMetroOptions = {}): Promise<ReloadMetroResult> {
  const runtime = await import('./metro/client-metro.ts');
  return await runtime.reloadMetro(input);
}

export async function stopMetroTunnel(options: StopMetroTunnelOptions): Promise<void> {
  const { stopMetroCompanion } = await import('./companion/client-metro-companion.ts');
  await stopMetroCompanion(options);
}

export async function runReactDevtools(
  args: string[],
  options: ReactDevtoolsCommandOptions,
): Promise<ReactDevtoolsOutput> {
  const [command, ...rest] = args;
  let output: ReactDevtoolsOutput | undefined;
  if (command === 'profile') {
    const { runReactProfileCommand } = await import('./react-devtools/react-profile-command.ts');
    output = await runReactProfileCommand(rest, options);
  } else {
    const { isInspectCommand, runReactInspectCommand } =
      await import('./react-devtools/react-devtools-inspect-command.ts');
    if (isInspectCommand(command)) output = await runReactInspectCommand(command, rest, options);
  }
  if (!output)
    throw new AppError('INVALID_ARGS', `Unknown react-devtools command: ${command ?? '(none)'}.`, {
      hint: 'Use react-devtools tree, find, inspect, errors, or profile.',
    });
  return output;
}

export async function recordPreparedMetroSession(
  options: MetroSessionOptions,
  result: Pick<PrepareMetroRuntimeResult, 'statusUrl' | 'iosRuntime' | 'androidRuntime'>,
): Promise<void> {
  const session = await import('./metro/metro-session-hints.ts');
  session.recordPreparedMetroSession(options, result);
}

export async function recordOpenedMetroSession(
  options: MetroSessionOptions,
  input: MetroSessionOpenInput,
): Promise<void> {
  const session = await import('./metro/metro-session-hints.ts');
  session.recordOpenedMetroSession(options, input);
}

export async function readMetroSessionRuntime(
  options: MetroSessionOptions,
): Promise<SessionRuntimeHints | undefined> {
  const session = await import('./metro/metro-session-hints.ts');
  return session.readMetroSessionRuntime(options);
}

export async function clearMetroSessionHintsQuietly(options: MetroSessionOptions): Promise<void> {
  const session = await import('./metro/metro-session-hints.ts');
  session.clearMetroSessionHintsQuietly(options);
}
