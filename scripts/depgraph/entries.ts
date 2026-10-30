import fs from 'node:fs';
import path from 'node:path';
import { buildEntries } from '../build-entries.ts';
import { readWorkspacePackages, runtimeExportTarget } from '../layering/package-boundaries.ts';

export type EntryManifest = Record<string, { id: string; subpath: string }[]>;

export function graphEntries(repoRoot: string, ids: ReadonlySet<string>): EntryManifest {
  const entries: EntryManifest = {};
  const add = (pkg: string, id: string, subpath: string) => {
    const source = ids.has(id) ? id : id.replace(/\.js$/, '.ts');
    if (ids.has(source)) (entries[pkg] ??= []).push({ id: source.replace(/^src\//, ''), subpath });
  };
  const root = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    exports:
      | string
      | Record<string, { default?: string; import?: string; require?: string } | string>;
  };
  const rootExports = typeof root.exports === 'string' ? { '.': root.exports } : root.exports;
  for (const [subpath, value] of Object.entries(rootExports)) {
    const target = runtimeExportTarget(value);
    if (!target) continue;
    const name = target.replace(/^\.\/dist\/src\//, '').replace(/\.js$/, '');
    const source = (buildEntries as Record<string, string>)[name];
    if (!source) throw new Error(`Root export ${subpath} points to unknown build entry ${target}.`);
    add('src (agent-device)', source, subpath);
  }
  for (const pkg of readWorkspacePackages(repoRoot)) {
    for (const [specifier, target] of pkg.exportTargets) {
      add(pkg.dir, target, specifier === pkg.name ? '.' : `.${specifier.slice(pkg.name.length)}`);
    }
  }
  return entries;
}
