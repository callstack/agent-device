import fs from 'node:fs';
import path from 'node:path';

export function walkFiles(root: string, predicate?: (file: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return walkFiles(entryPath, predicate);
    return !predicate || predicate(entryPath) ? [entryPath] : [];
  });
}
