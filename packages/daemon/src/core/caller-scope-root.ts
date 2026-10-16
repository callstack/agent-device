import fs from 'node:fs';
import path from 'node:path';

/**
 * The canonical workspace root a caller's cwd belongs to: the git worktree root when the
 * cwd sits inside one, otherwise the realpath of the directory. Two commands issued from
 * different directories of one checkout resolve to the same root, so it is the comparison
 * key for anything that asks "did this caller and that record come from the same
 * workspace?" — session routing hashes it into the implicit session address, and
 * device-claim coverage (#3345) compares covered claims by it rather than by the raw cwd,
 * which would refuse an owner that ran `open` from the checkout root and `install` from a
 * subdirectory of it.
 */
export function resolveCallerScopeRoot(rawCwd: string | undefined): string | undefined {
  if (!rawCwd || rawCwd.trim().length === 0) return undefined;
  const cwd = resolveExistingPath(rawCwd);
  return findGitWorktreeRoot(cwd) ?? cwd;
}

function resolveExistingPath(rawPath: string): string {
  const resolved = path.resolve(rawPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function findGitWorktreeRoot(startDir: string): string | undefined {
  let current = startDir;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
