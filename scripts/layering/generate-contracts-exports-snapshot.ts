// Regenerates contracts-exports.snapshot.json from packages/contracts/package.json#exports.
//
// package-boundaries.test.ts diffs the live manifest's export specifiers against this committed
// snapshot so widening or shrinking `@agent-device/contracts`'s export surface fails the gate
// (the property the deleted ~120-line inline CONTRACT_EXPORTS pin used to give). The snapshot is a
// separate file rather than an inline list so an editor who adds or removes a contracts subpath
// runs this script and reviews the diff, instead of hand-retyping an alphabetized array.
//
// Run after any packages/contracts/package.json#exports change:
//   node --experimental-strip-types scripts/layering/generate-contracts-exports-snapshot.ts
// then commit the resulting snapshot diff alongside the manifest change.

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const manifestFile = 'packages/contracts/package.json';
const snapshotFile = path.join(import.meta.dirname, 'contracts-exports.snapshot.json');

const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, manifestFile), 'utf8')) as {
  name?: string;
  exports?: Record<string, unknown>;
};
if (!manifest.name) throw new Error(`${manifestFile} has no "name"`);

const specifiers = Object.keys(manifest.exports ?? {})
  .map((subpath) => path.posix.join(manifest.name!, subpath))
  .sort();

fs.writeFileSync(snapshotFile, `${JSON.stringify(specifiers, null, 2)}\n`);
console.log(
  `Wrote ${specifiers.length} export specifiers to ${path.relative(repoRoot, snapshotFile)}`,
);
