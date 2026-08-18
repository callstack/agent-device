import fs from 'node:fs';
import path from 'node:path';
import { replayScriptSourceBundleFor } from '../../../__tests__/test-utils/replay-script-source.ts';
import type { DaemonRequest } from '../../types.ts';

export function writeReplayFile(root: string, lines: string[]): string {
  const filePath = path.join(root, 'flow.ad');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

/**
 * A `replay` request shaped the way the CLI actually sends one: #1802 made the
 * CALLER read every script file the run needs, so a request whose first
 * positional names a script also carries that script's source bundle. Tests
 * pass `positionals: [filePath]` as before and the bundle is built from the
 * same file, exactly as `replayDaemonWriter` builds it.
 */
export function baseReplayRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  const positionals = overrides.positionals ?? [];
  const scriptPath = positionals[0];
  const flags = overrides.flags;
  return {
    token: 'token',
    session: 'default',
    command: 'replay',
    ...overrides,
    positionals,
    ...(scriptPath !== undefined && flags?.replayScriptSource === undefined
      ? {
          flags: {
            ...(flags ?? {}),
            replayScriptSource: replayScriptSourceBundleFor(scriptPath, {
              replayBackend: flags?.replayBackend,
            }),
          },
        }
      : {}),
  };
}
