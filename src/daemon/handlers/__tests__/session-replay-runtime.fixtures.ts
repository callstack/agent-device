import fs from 'node:fs';
import path from 'node:path';
import type { DaemonRequest } from '../../types.ts';

export function writeReplayFile(root: string, lines: string[]): string {
  const filePath = path.join(root, 'flow.ad');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

export function baseReplayRequest(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'token',
    session: 'default',
    command: 'replay',
    positionals: [],
    ...overrides,
  };
}
