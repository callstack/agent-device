import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves an internal build entry module that ships next to the calling
 * module: `<dir>/<name>.ts` when running from source and
 * `<dir>/internal/<name>.js` (or `<dir>/<name>.js` when the caller is already
 * bundled under `internal/`) when running from `dist`. Returns null when
 * `importMetaUrl` is not a file URL (bundled/SEA contexts) or no candidate
 * exists on disk, so callers can degrade gracefully.
 */
export function resolveInternalEntryModulePath(
  importMetaUrl: string,
  entryBaseName: string,
): string | null {
  try {
    const currentModulePath = fileURLToPath(importMetaUrl);
    const extension = path.extname(currentModulePath) || '.js';
    const candidates = [
      path.join(path.dirname(currentModulePath), `${entryBaseName}${extension}`),
      path.join(path.dirname(currentModulePath), 'internal', `${entryBaseName}${extension}`),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  } catch {
    return null;
  }
}
