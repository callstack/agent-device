import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

export function makeTempWorkspace(): { root: string; home: string; project: string } {
  const root = mkdtempForTestSync('agent-device-config-');
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  return { root, home, project };
}
