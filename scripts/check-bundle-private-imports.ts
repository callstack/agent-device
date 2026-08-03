import fs from 'node:fs';
import path from 'node:path';
import { runAsMain } from './lib/run-as-main.ts';
import { walkFiles } from './lib/walk-files.ts';

const PRIVATE_WORKSPACE_IMPORT_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\.meta\.resolve\s*\(\s*)(["'])(@agent-device\/[^"'\\]+)\1/g;

export type BundleSource = {
  file: string;
  content: string;
};

export type PrivateWorkspaceImportLeak = {
  file: string;
  specifier: string;
};

export function findPrivateWorkspaceImportLeaks(
  sources: readonly BundleSource[],
): PrivateWorkspaceImportLeak[] {
  const seen = new Set<string>();
  const leaks: PrivateWorkspaceImportLeak[] = [];
  for (const source of sources) {
    for (const match of source.content.matchAll(PRIVATE_WORKSPACE_IMPORT_RE)) {
      const specifier = match[2];
      if (!specifier) continue;
      const key = `${source.file}\0${specifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      leaks.push({ file: source.file, specifier });
    }
  }
  return leaks;
}

function run(): number {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const distRoot = path.join(repoRoot, 'dist', 'src');
  const bundleFiles = walkFiles(distRoot).filter((file) => file.endsWith('.js'));
  if (bundleFiles.length === 0) {
    throw new Error('No dist/src JavaScript files found. Run `pnpm build` first.');
  }

  const leaks = findPrivateWorkspaceImportLeaks(
    bundleFiles.map((file) => ({
      file: path.relative(repoRoot, file),
      content: fs.readFileSync(file, 'utf8'),
    })),
  );
  if (leaks.length > 0) {
    const details = leaks.map(({ file, specifier }) => `- ${specifier} in ${file}`).join('\n');
    throw new Error(
      `Private workspace imports leaked into production bundles:\n${details}\n` +
        'Run `pnpm install` so workspace packages resolve, then rebuild before publishing.',
    );
  }

  process.stdout.write(
    `Verified ${bundleFiles.length} production bundles contain no private workspace imports.\n`,
  );
  return 0;
}

runAsMain(import.meta.url, 'check:bundle-private-imports', run);
