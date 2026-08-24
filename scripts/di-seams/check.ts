// `pnpm check:di-seams` — fails if a test-only DI seam (an optional `field?: typeof X`
// parameter that exists only to let a test inject an alternate implementation) reappears in
// production code without a `// di-seam-approved: <reason>` comment directly above it. See
// model.ts for how a match and its approval are found; #1976 / PR #2006 for why approval lives
// as a comment on the declaration rather than in an external table.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkSeams, findSeamMatches, type SourceFile } from './model.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

function listProductionSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'src'], { cwd: repoRoot, encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.includes('/__tests__/') && !file.endsWith('.test.ts'));
}

function readSources(files: readonly string[]): SourceFile[] {
  return files.map((file) => ({
    path: file,
    source: fs.readFileSync(path.join(repoRoot, file), 'utf8'),
  }));
}

export function main(): number {
  const files = readSources(listProductionSourceFiles());
  const matches = findSeamMatches(files);
  const approved = matches.filter((match) => match.approvalReason !== null);
  const { violations } = checkSeams(matches);

  if (violations.length === 0) {
    process.stdout.write(
      `DI-seam guard: OK — ${files.length} production src/ files scanned, ` +
        `${approved.length} approved seam(s) found, no unapproved seams.\n`,
    );
    return 0;
  }

  process.stderr.write(
    `Found ${violations.length} test-only DI seam(s) (optional typeof params) in production code:\n`,
  );
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file}:${violation.line}: ${violation.text}\n`);
    process.stderr.write(
      `::error file=${violation.file},line=${violation.line},title=Test-only DI seam::` +
        `${violation.text}\n`,
    );
  }
  process.stderr.write(
    '\nIf this is a deliberate, reviewed injection seam and not a leftover test seam, add a ' +
      '`// di-seam-approved: <reason>` comment directly above the declaration — do not broaden ' +
      'the pattern in model.ts to exempt it by name.\n\n',
  );
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
