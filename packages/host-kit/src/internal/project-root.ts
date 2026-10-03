import fs from 'node:fs';
import path from 'node:path';

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
      } catch {}
    }
    current = path.dirname(current);
  }
  return nearest ?? startDirectory;
}

/**
 * The daemon's own source, relative to a project root. One path answers two questions
 * with it: whether a tree is a source checkout at all, and which entry a checkout
 * launches its daemon from (`src/daemon-client/daemon-launch-spec.ts`).
 */
export const DAEMON_SOURCE_ENTRY = 'src/daemon.ts';

/**
 * Whether `root` is a source checkout rather than an installed copy of a published
 * version. The published package ships its `bin` and `dist` and no `src`, so the
 * daemon's own source is what tells the two apart — and that is the difference between
 * a tree whose code can be rebuilt under its own version and one whose version already
 * fixes its bytes.
 */
export function isSourceCheckoutProjectRoot(root: string): boolean {
  return (
    fs.existsSync(path.join(root, 'package.json')) &&
    fs.existsSync(path.join(root, DAEMON_SOURCE_ENTRY))
  );
}
