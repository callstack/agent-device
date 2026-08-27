import fs from 'node:fs';
import path from 'node:path';

/** Walks up from `startDirectory` to the manifest named `agent-device`; the first manifest found is the fallback for renamed or vendored installs. */
export function resolveAgentDeviceProjectRoot(startDirectory: string): string {
  let current = startDirectory;
  let nearest: string | null = null;
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      nearest ??= current;
      try {
        const name = (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: unknown }).name;
        if (name === 'agent-device') return current;
      } catch {
        // an unreadable manifest is not the root; keep walking
      }
    }
    current = path.dirname(current);
  }
  return nearest ?? startDirectory;
}
