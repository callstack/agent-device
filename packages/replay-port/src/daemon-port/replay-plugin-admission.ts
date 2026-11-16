import type { ReplayBackendId } from '@agent-device/ad-script';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { getReplayBackend, getReplayExecution } from './replay-backend-registry.ts';

/** Rejects unavailable execution before request binding can select or act on a device. */
export async function requireReplayPlugins(request: DaemonWireRequest): Promise<void> {
  const { isReplayBackendId, unsupportedReplayBackendMessage } =
    await import('@agent-device/ad-script');
  const backend = request.flags?.replayBackend;
  if (backend !== undefined && !isReplayBackendId(backend))
    throw new AppError('INVALID_ARGS', unsupportedReplayBackendMessage(backend));
  if (request.command === 'test') await requireReplayTestPlugins(request, backend);
  else if (request.command === 'replay') await requireReplayEntryPlugin(request, backend);
}

async function requireReplayTestPlugins(
  request: DaemonWireRequest,
  backend: ReplayBackendId | undefined,
): Promise<void> {
  const { resolveReplayFormat, isMaestroYamlPath, maestroBackendRequiredMessage } =
    await import('@agent-device/ad-script');
  const entry = request.flags?.replayScriptSources?.find((source) =>
    isMaestroYamlPath(source.entry),
  )?.entry;
  if (entry !== undefined && backend !== 'maestro')
    throw new AppError('INVALID_ARGS', maestroBackendRequiredMessage('test', entry));
  await getReplayExecution();
  if (
    request.flags?.replayScriptSources?.some(
      (source) => resolveReplayFormat(source.entry, backend) === 'maestro',
    )
  )
    await getReplayBackend('maestro');
}

async function requireReplayEntryPlugin(
  request: DaemonWireRequest,
  backend: ReplayBackendId | undefined,
): Promise<void> {
  const { resolveReplayFormat, isMaestroYamlPath, maestroBackendRequiredMessage } =
    await import('@agent-device/ad-script');
  const entry = request.flags?.replayScriptSource?.entry ?? request.positionals?.[0] ?? '';
  if (isMaestroYamlPath(entry) && backend !== 'maestro')
    throw new AppError('INVALID_ARGS', maestroBackendRequiredMessage('replay', entry));
  if (resolveReplayFormat(entry, backend) === 'maestro') await getReplayBackend('maestro');
  else await getReplayExecution();
}
