import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import { resolveUserPath } from '../utils/path-resolution.ts';
import { resolveReplayFormat } from './format.ts';

/**
 * The caller-side half of the replay script source bundle (#1802): the CLI,
 * the Node client, and the MCP tools all reach the daemon through the replay
 * command family's daemon writers, and every one of them builds its bundle
 * here — there is no separate remote path, so "works locally, ENOENT in CI"
 * cannot come back.
 *
 * Reading is the caller's job because only the caller has the files. That also
 * moves the "no such script" failure to where the path means something: it is
 * raised against the caller's own filesystem, naming the path as typed, before
 * any daemon round-trip.
 *
 * `@agent-device/maestro` is loaded ON DEMAND, inside `loadReplayScriptSourceBundle`, and only
 * when the entry resolves to a flow. The replay command family is part of the CLI's startup import
 * closure (the command registry evaluates it for `--help` and every other invocation), and the
 * Maestro engine drags its YAML parser in with it — statically importing it here cost ~28ms on
 * every warm command and a 131 kB startup chunk. `src/__tests__/cli-startup-import-closure.test.ts`
 * holds that line; ADR 0019 and #1681/#1641 are the same rule applied to `node:http` and the help
 * fast path.
 */

/**
 * Total bundled text a single replay request may carry. `.ad` scripts and
 * Maestro flows are kilobytes; a bundle this large is a mistake (a directory
 * of generated flows, a binary renamed to `.ad`) and is worth refusing with a
 * clear message rather than pushing megabytes through the RPC envelope.
 */
export const REPLAY_SCRIPT_SOURCE_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What a daemon says when a request carries only a path. There is no path
 * fallback: a pre-#1802 client sending a bare path against a newer daemon is
 * told what is missing and what to do, instead of getting an `ENOENT` for a
 * file that exists on the machine it typed the command on.
 */
export const REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE =
  'This replay request carries no script sources. Replay scripts are read by the client and sent with the request; upgrade the agent-device client that issued it to a version that sends script sources.';

export type ReplayScriptSourceRequest = {
  /** The script path as the caller typed it — used verbatim in a not-found error. */
  inputPath: string;
  cwd: string;
  replayBackend?: string;
  /** `${VAR}` values that can resolve a Maestro `runFlow` include path before the run starts. */
  env?: Readonly<Record<string, string>>;
};

/**
 * The one bundle constructor every client surface goes through (CLI, Node client, MCP — they all
 * reach the daemon via the replay command family's writers). Async because the Maestro branch
 * loads its engine on demand; the native `.ad` branch touches nothing beyond the entry file.
 */
export async function loadReplayScriptSourceBundle(
  params: ReplayScriptSourceRequest,
): Promise<ReplayScriptSourceBundle> {
  const entry = resolveUserPath(params.inputPath, { cwd: params.cwd });
  const entrySource = readReplayEntryScript(entry, params.inputPath);
  if (resolveReplayFormat(entry, params.replayBackend) !== 'maestro') {
    return finishBundle(entry, { [entry]: entrySource }, params.inputPath);
  }
  const { collectMaestroFlowSources } = await import('@agent-device/maestro');
  const files = collectMaestroFlowSources({
    entryPath: entry,
    entrySource,
    env: params.env,
    readSource: tryReadScriptFile,
  });
  return finishBundle(entry, files, params.inputPath);
}

/**
 * A native `.ad` script IS its own whole bundle — it has no include grammar — so this needs
 * neither the Maestro engine nor an await. `loadReplayScriptSourceBundle` is the entry point
 * callers use; this is the `.ad` half of it, exported so a test fixture can build the shape the
 * client really sends without hand-rolling it.
 */
export function readAdScriptSourceBundle(
  params: Pick<ReplayScriptSourceRequest, 'inputPath' | 'cwd'>,
): ReplayScriptSourceBundle {
  const entry = resolveUserPath(params.inputPath, { cwd: params.cwd });
  return finishBundle(
    entry,
    { [entry]: readReplayEntryScript(entry, params.inputPath) },
    params.inputPath,
  );
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

/** Reads one bundled file, failing with the same vocabulary on both sides of the wire. */
export function readReplayScriptSourceFile(
  bundle: ReplayScriptSourceBundle,
  resolvedPath: string,
): string {
  const script = bundle.files[resolvedPath];
  if (script === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      `replay script source is missing ${resolvedPath}; it was not part of the script sources sent with this request.`,
      { path: resolvedPath, entry: bundle.entry },
    );
  }
  return script;
}
