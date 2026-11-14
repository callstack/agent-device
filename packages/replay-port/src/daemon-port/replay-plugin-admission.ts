import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { getReplayBackend, getReplayExecution } from './replay-backend-registry.ts';

/** Rejects unavailable execution before request binding can select or act on a device. */
export async function requireReplayPlugins(request: DaemonWireRequest): Promise<void> {
  const {
    isReplayBackendId,
    unsupportedReplayBackendMessage,
    resolveReplayFormat,
    isMaestroYamlPath,
    maestroBackendRequiredMessage,
  } = await import('@agent-device/ad-script');
  const backend = request.flags?.replayBackend;
  if (backend !== undefined && !isReplayBackendId(backend))
    throw new AppError('INVALID_ARGS', unsupportedReplayBackendMessage(backend));
  if (request.command === 'test') {
    await getReplayExecution();
    if (
      request.flags?.replayScriptSources?.some(
        (source) => resolveReplayFormat(source.entry, request.flags?.replayBackend) === 'maestro',
      )
    )
      await getReplayBackend('maestro');
  } else if (request.command === 'replay') {
    const entry = request.flags?.replayScriptSource?.entry ?? request.positionals?.[0] ?? '';
    if (isMaestroYamlPath(entry) && backend !== 'maestro')
      throw new AppError('INVALID_ARGS', maestroBackendRequiredMessage('replay', entry));
    if (resolveReplayFormat(entry, request.flags?.replayBackend) === 'maestro')
      await getReplayBackend('maestro');
    else await getReplayExecution();
  }
}
