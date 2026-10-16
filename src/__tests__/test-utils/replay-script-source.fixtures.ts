import fs from 'node:fs';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import { resolveUserPath } from '@agent-device/host-kit/file';
import { loadReplayScriptSourceBundle } from '@agent-device/replay-port/script-source-bundle';
import { discoverReplaySourcePaths } from '@agent-device/replay-port/source-discovery';

export function replayScriptSourceBundleFor(filePath: string): ReplayScriptSourceBundle {
  const entry = resolveUserPath(filePath, { cwd: process.cwd() });
  return { entry, files: { [entry]: fs.readFileSync(entry, 'utf8') } };
}

/** Attaches the script sources a real client collects for `replay`/`test`; any other request passes through. */
export async function withClientReplayScriptSources(
  req: DaemonWireRequest,
): Promise<DaemonWireRequest> {
  const inputs = req.positionals ?? [];
  if ((req.command !== 'replay' && req.command !== 'test') || inputs[0] === undefined) return req;
  const cwd = req.meta?.cwd ?? process.cwd();
  const replayBackend = req.flags?.replayBackend;
  const withFlags = (flags: NonNullable<DaemonWireRequest['flags']>) => ({
    ...req,
    flags: { ...req.flags, ...flags },
  });
  try {
    if (req.command === 'replay') {
      if (req.flags?.replayScriptSource) return req;
      const replayScriptSource = await loadReplayScriptSourceBundle({
        inputPath: inputs[0],
        cwd,
        replayBackend,
      });
      return withFlags({ replayScriptSource });
    }
    if (req.flags?.replayScriptSources) return req;
    const replayScriptSources = await Promise.all(
      discoverReplaySourcePaths({ inputs, cwd, replayBackend }).map(
        async (inputPath) => await loadReplayScriptSourceBundle({ inputPath, cwd, replayBackend }),
      ),
    );
    return withFlags({ replayScriptSources });
  } catch {
    return req;
  }
}
