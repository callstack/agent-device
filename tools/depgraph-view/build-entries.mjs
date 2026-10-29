#!/usr/bin/env node
// Emits entries.json for the depgraph viewer: the declared entry point of every
// workspace package subpath, as the source file ids the graph already knows.
//
//   node tools/depgraph-view/build-entries.mjs [--graph <graph.json>] [--out <entries.json>]
//
// Root entry sources come from tsdown's entry map.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : fallback;
};

const graphPath = flag('--graph', path.join(repoRoot, 'tools/depgraph-view/graph.json'));
const outPath = flag('--out', path.join(repoRoot, 'tools/depgraph-view/entries.json'));

const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
const ids = new Set(graph.nodes.map((n) => n.id));

const targetsOf = (value) =>
  [value]
    .flat()
    .flatMap((v) => {
      const d = v && typeof v === 'object' ? (v.default ?? v.import ?? v.require) : v;
      return [d];
    })
    .filter((d) => typeof d === 'string');

function packageEntries(pkgDir, exports, probe) {
  const out = [];
  for (const [subpath, value] of Object.entries(exports)) {
    for (const target of targetsOf(value)) {
      if (!target.startsWith('./')) continue;
      for (const id of probe(target)) {
        if (ids.has(id)) {
          out.push({ id, subpath: subpath === '.' ? '.' : subpath });
          break;
        }
      }
    }
  }
  return out;
}

const packages = {};

const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const rootExports =
  typeof rootPkg.exports === 'string' ? { '.': rootPkg.exports } : rootPkg.exports;
const buildConfig = await import(pathToFileURL(path.join(repoRoot, 'tsdown.config.ts')).href);
const root = packageEntries('.', rootExports, (target) => {
  const name = target.replace('./dist/src/', '').replace(/\.js$/, '');
  const source = buildConfig.default.entry[name];
  return source ? [source.replace(/^src\//, '')] : [];
});
if (root.length) packages['src (agent-device)'] = root;

const packageDirs = new Set();
for (const node of graph.nodes) {
  const m = /^(packages\/[^/]+)\//.exec(node.id);
  if (m) packageDirs.add(m[1]);
}
for (const pkgDir of [...packageDirs].sort()) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, pkgDir, 'package.json'), 'utf8'));
  const exports =
    typeof manifest.exports === 'string' ? { '.': manifest.exports } : (manifest.exports ?? {});
  const entries = packageEntries(pkgDir, exports, (target) => [
    `${pkgDir}/${target.slice(2)}`,
    `${pkgDir}/${target.slice(2).replace(/\.js$/, '.ts')}`,
  ]);
  if (entries.length) packages[pkgDir] = entries;
}

const declared = Object.values(packages).reduce((sum, list) => sum + list.length, 0);
const expected =
  Object.keys(rootExports).length +
  [...packageDirs].reduce(
    (sum, dir) =>
      sum +
      Object.keys(
        JSON.parse(fs.readFileSync(path.join(repoRoot, dir, 'package.json'), 'utf8')).exports ?? {},
      ).length,
    0,
  );
fs.writeFileSync(outPath, `${JSON.stringify(packages, null, 2)}\n`);
process.stdout.write(
  `entries: ${declared} of ${expected} declared subpaths across ${Object.keys(packages).length} packages\n` +
    (declared === expected
      ? '  every declared subpath resolved to a graph node\n'
      : '  some subpaths had no graph node (excluded or renamed)\n') +
    `  wrote ${path.relative(repoRoot, outPath)}\n`,
);
