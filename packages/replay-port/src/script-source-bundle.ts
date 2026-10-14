import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import { resolveUserPath } from '@agent-device/host-kit/file';
import { resolveReplayFormat } from '@agent-device/ad-script';
import type { ReplayBackend } from '@agent-device/replay-port/replay-backend-registry';

export const REPLAY_SCRIPT_SOURCE_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;

export type ReplayScriptSourceRequest = {
  inputPath: string;
  cwd: string;
  replayBackend?: string;
  env?: Readonly<Record<string, string>>;
};

export async function loadReplayScriptSourceBundle(
  params: ReplayScriptSourceRequest,
): Promise<ReplayScriptSourceBundle> {
  const entry = resolveUserPath(params.inputPath, { cwd: params.cwd });
  const entrySource = readReplayEntryScript(entry, params.inputPath);
  const backendId = resolveReplayFormat(entry, params.replayBackend);
  if (backendId === 'ad') {
    return finishBundle(entry, { [entry]: entrySource }, params.inputPath);
  }
  // Function-scoped on purpose: the eager-closure budget gate counts a static import here as a
  // module every warm CLI command evaluates, for a format most runs never use (#1802), and the
  // backend's engine sits one thunk behind it (#3377).
  const backend: ReplayBackend = await (
    await import('@agent-device/replay-port/replay-backend-registry')
  ).getReplayBackend(backendId);
  const files = backend.collectSourceFiles({
    entryPath: entry,
    entrySource,
    env: params.env,
    readSource: tryReadScriptFile,
  });
  return finishBundle(entry, files, params.inputPath);
}

function finishBundle(
  entry: string,
  files: Record<string, string>,
  inputPath: string,
): ReplayScriptSourceBundle {
  assertBundleWithinLimit(files, inputPath);
  return { entry, files };
}

function readReplayEntryScript(resolvedPath: string, inputPath: string): string {
  try {
    return fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `replay script not found on this machine: ${inputPath}`,
      {
        path: resolvedPath,
        hint: 'Replay scripts are read by the client and sent to the daemon, so the path must resolve where you ran the command.',
      },
      error instanceof Error ? error : undefined,
    );
  }
}

function tryReadScriptFile(resolvedPath: string): string | undefined {
  try {
    return fs.readFileSync(resolvedPath, 'utf8');
  } catch {
    return undefined;
  }
}

function assertBundleWithinLimit(files: Record<string, string>, inputPath: string): void {
  const totalBytes = Object.values(files).reduce(
    (total, script) => total + Buffer.byteLength(script, 'utf8'),
    0,
  );
  if (totalBytes <= REPLAY_SCRIPT_SOURCE_BUNDLE_MAX_BYTES) return;
  throw new AppError(
    'INVALID_ARGS',
    `replay script sources for ${inputPath} total ${totalBytes} bytes, over the ${REPLAY_SCRIPT_SOURCE_BUNDLE_MAX_BYTES}-byte limit; split the flow or drop unused runFlow includes.`,
    { limitBytes: REPLAY_SCRIPT_SOURCE_BUNDLE_MAX_BYTES, totalBytes },
  );
}
