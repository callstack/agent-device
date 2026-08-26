import { AppError } from '@agent-device/kernel/errors';
import type { AppLogRuntimeHost, AppLogStartInput } from '@agent-device/contracts/app-log-runtime';

export type AppLogArtifactPaths = Readonly<{
  outputPath: string;
  pidPath?: string;
}>;

export function appLogSessionArtifactsMatch(
  host: AppLogRuntimeHost,
  sessionId: string,
  paths: AppLogArtifactPaths,
): boolean {
  const expected = host.artifacts.resolveSession(sessionId);
  return (
    paths.outputPath === expected.outputPath &&
    (paths.pidPath === undefined || paths.pidPath === expected.pidPath)
  );
}

export function assertAppLogSessionArtifacts(
  host: AppLogRuntimeHost,
  input: AppLogStartInput,
): void {
  if (appLogSessionArtifactsMatch(host, input.sessionId, input)) return;
  throw new AppError('INVALID_ARGS', 'App-log paths do not match the owning session');
}
