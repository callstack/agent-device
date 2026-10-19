import fs from 'node:fs';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { resolveUserPath } from '@agent-device/host-kit/file';
import { loadReplayScriptSourceBundle } from '@agent-device/replay-port/script-source-bundle';
import { discoverReplaySourcePaths } from '@agent-device/replay-port/source-discovery';

/** A native `.ad` script's one-entry source bundle for test requests. */
export function replayScriptSourceBundleFor(filePath: string): ReplayScriptSourceBundle {
  const entry = resolveUserPath(filePath, { cwd: process.cwd() });
  return { entry, files: { [entry]: fs.readFileSync(entry, 'utf8') } };
}

/** A Maestro flow's bundle — async because the engine that walks its includes loads on demand. */
export async function maestroScriptSourceBundleFor(
  filePath: string,
): Promise<ReplayScriptSourceBundle> {
  return await loadReplayScriptSourceBundle({
    inputPath: filePath,
    cwd: process.cwd(),
    replayBackend: 'maestro',
  });
}

/**
 * Attaches the script sources a real client would have collected for a `replay`/`test` request
 * (#1802): the daemon opens no caller path, so every request that reaches one carries them.
 * Test harnesses that stand in for "a request as it arrives at the daemon" call this so their
 * cases keep expressing what they are about; a request that already carries its own sources (or
 * deliberately carries none, to pin the daemon's refusal) is returned untouched.
 *
 * Collection that cannot succeed — a case driving `replay` at a path that deliberately does not
 * exist — leaves the request alone rather than throwing: the real client raises that failure at
 * the CLI boundary (pinned in `cli-client-commands.test.ts`), and a daemon-level harness must
 * still deliver the request so the daemon's own response is what the case observes.
 */
export async function withClientReplayScriptSources(
  req: DaemonWireRequest,
): Promise<DaemonWireRequest> {
  if (req.command !== 'replay' && req.command !== 'test') return req;
  const inputs = req.positionals ?? [];
  const entryPath = inputs[0];
  if (entryPath === undefined) return req;
  const cwd = req.meta?.cwd ?? process.cwd();
  const replayBackend = req.flags?.replayBackend;
  try {
    if (req.command === 'replay') {
      if (req.flags?.replayScriptSource) return req;
      return withFlags(req, {
        replayScriptSource: await loadReplayScriptSourceBundle({
          inputPath: entryPath,
          cwd,
          replayBackend,
        }),
      });
    }
    if (req.flags?.replayScriptSources) return req;
    return withFlags(req, {
      replayScriptSources: await Promise.all(
        discoverReplaySourcePaths({ inputs, cwd, replayBackend }).map(
          async (inputPath) =>
            await loadReplayScriptSourceBundle({ inputPath, cwd, replayBackend }),
        ),
      ),
    });
  } catch {
    return req;
  }
}

function withFlags(
  req: DaemonWireRequest,
  flags: Partial<NonNullable<DaemonWireRequest['flags']>>,
): DaemonWireRequest {
  return { ...req, flags: { ...(req.flags ?? {}), ...flags } };
}
