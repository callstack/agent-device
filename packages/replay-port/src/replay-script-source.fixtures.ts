import fs from 'node:fs';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import { resolveUserPath } from '@agent-device/host-kit/file';
import { loadReplayScriptSourceBundle } from './script-source-bundle.ts';

export function replayScriptSourceBundleFor(filePath: string): ReplayScriptSourceBundle {
  const entry = resolveUserPath(filePath, { cwd: process.cwd() });
  return { entry, files: { [entry]: fs.readFileSync(entry, 'utf8') } };
}

export async function maestroScriptSourceBundleFor(
  filePath: string,
): Promise<ReplayScriptSourceBundle> {
  return await loadReplayScriptSourceBundle({
    inputPath: filePath,
    cwd: process.cwd(),
    replayBackend: 'maestro',
  });
}
