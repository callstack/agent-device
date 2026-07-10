import fs from 'node:fs';
import path from 'node:path';
import { COMMAND_OWNER_FILES } from '../src/core/command-descriptor/owner-files.ts';
import { getDaemonRouteOwnerFiles } from '../src/daemon/route-owner-files.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const distRoot = path.join(repoRoot, 'dist', 'src');
const ownerPaths = new Set([
  ...Object.values(COMMAND_OWNER_FILES).flat(),
  ...Object.values(getDaemonRouteOwnerFiles()),
]);

const bundleFiles = walkFiles(distRoot).filter((file) => file.endsWith('.js'));
if (bundleFiles.length === 0) {
  throw new Error('No dist/src JavaScript files found. Run `pnpm build` first.');
}

const leaks = bundleFiles.flatMap((file) => {
  const content = fs.readFileSync(file, 'utf8');
  return [...ownerPaths]
    .filter((ownerPath) => content.includes(ownerPath))
    .map((ownerPath) => ({ file: path.relative(repoRoot, file), ownerPath }));
});

if (leaks.length > 0) {
  const details = leaks.map(({ file, ownerPath }) => `- ${ownerPath} in ${file}`).join('\n');
  throw new Error(`Owner-file navigation metadata leaked into production bundles:\n${details}`);
}

process.stdout.write(
  `Verified ${ownerPaths.size} owner-file paths are absent from ${bundleFiles.length} production bundles.\n`,
);

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
  });
}
