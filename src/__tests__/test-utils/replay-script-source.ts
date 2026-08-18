import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import type { MaestroSourceReader } from '@agent-device/maestro';
import type { DaemonRequest } from '../../daemon/types.ts';
import { buildReplayScriptSourceBundle } from '../../replay/script-source-bundle.ts';
import { discoverReplaySourcePaths } from '../../replay/source-discovery.ts';

/**
 * Builds a replay script source bundle from a file on disk the way a real
 * caller does (#1802) — through the client's own builder, so a test never
 * hand-rolls a bundle shape the CLI would not actually send.
 */
export function replayScriptSourceBundleFor(
  filePath: string,
  options: { replayBackend?: string } = {},
): ReplayScriptSourceBundle {
  return buildReplayScriptSourceBundle({
    inputPath: filePath,
    cwd: process.cwd(),
    replayBackend: options.replayBackend,
  });
}

/**
 * `readSource` for a flow that declares no `runFlow` includes: the engine must
 * never reach for one, so a call here means the fixture drifted rather than a
 * missing file.
 */
export const noMaestroIncludeSources: MaestroSourceReader = (resolvedPath) => {
  throw new Error(`unexpected Maestro include read: ${resolvedPath}`);
};

/**
 * Attaches the script sources a real client would have collected for a `replay`/`test` request
 * (#1802): the daemon opens no caller path, so every request that reaches one carries them.
 * Test harnesses that stand in for "a request as it arrives at the daemon" call this so their
 * cases keep expressing what they are about; a request that already carries its own sources (or
 * deliberately carries none, to pin the daemon's refusal) is returned untouched.
 */
export function withClientReplayScriptSources(req: DaemonRequest): DaemonRequest {
  if (req.command !== 'replay' && req.command !== 'test') return req;
  const inputs = req.positionals ?? [];
  if (inputs.length === 0) return req;
  const cwd = req.meta?.cwd ?? process.cwd();
  const replayBackend = req.flags?.replayBackend;
  const entryPath = inputs[0];
  if (req.command === 'replay') {
    if (req.flags?.replayScriptSource || entryPath === undefined) return req;
    return {
      ...req,
      flags: {
        ...(req.flags ?? {}),
        replayScriptSource: buildReplayScriptSourceBundle({
          inputPath: entryPath,
          cwd,
          replayBackend,
        }),
      },
    };
  }
  if (req.flags?.replayScriptSources) return req;
  return {
    ...req,
    flags: {
      ...(req.flags ?? {}),
      replayScriptSources: discoverReplaySourcePaths({ inputs, cwd, replayBackend }).map(
        (inputPath) => buildReplayScriptSourceBundle({ inputPath, cwd, replayBackend }),
      ),
    },
  };
}
