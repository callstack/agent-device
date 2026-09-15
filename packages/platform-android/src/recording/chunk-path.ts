import path from 'node:path';

/**
 * The host path of a recording's `index`th file (1-based). The first file keeps the base path and each
 * later one takes a `.part-NNN` suffix. Pulled, served and journaled chunk sets all follow this one
 * rule from their own base, which is what lets an attempt that never ran the pull name the files a
 * previous attempt left behind.
 */
export function chunkPathAt(basePath: string, index: number): string {
  if (index === 1) return basePath;
  const parsed = path.parse(basePath);
  return path.join(
    parsed.dir,
    `${parsed.name}.part-${String(index).padStart(3, '0')}${parsed.ext || '.mp4'}`,
  );
}
