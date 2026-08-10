import fs from 'node:fs';
import path from 'node:path';

type ManagedSessionArtifactPath = Readonly<{
  sessionsDir: string;
  pathname: string;
  basename: string;
  label: string;
}>;

export function requireManagedSessionArtifactPath(input: ManagedSessionArtifactPath): string {
  const root = path.resolve(input.sessionsDir);
  const resolved = path.resolve(input.pathname);
  if (path.basename(resolved) !== input.basename) {
    throw new Error(`${input.label} is outside the daemon-owned sessions directory`);
  }
  if (fs.existsSync(root) && fs.existsSync(path.dirname(resolved))) {
    const realRoot = fs.realpathSync.native(root);
    const realParent = fs.realpathSync.native(path.dirname(resolved));
    if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`${input.label} resolves outside the daemon-owned sessions directory`);
    }
    return path.join(realParent, input.basename);
  }
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${input.label} is outside the daemon-owned sessions directory`);
  }
  return resolved;
}
