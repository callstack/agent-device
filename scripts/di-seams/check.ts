// `pnpm check:di-seams` — fails if a test-only DI seam (an optional `field?: typeof X`
// parameter that exists only to let a test inject an alternate implementation) reappears in
// production code. See model.ts and approved.ts for how a match is judged; #1976 / PR #2006 for
// why the judgment is an explicit per-site allowlist rather than a name pattern.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APPROVED_SEAMS } from './approved.ts';
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
  const { violations, staleApprovals } = checkSeams(matches, APPROVED_SEAMS);

  if (violations.length === 0 && staleApprovals.length === 0) {
    process.stdout.write(
      `DI-seam guard: OK — ${files.length} production src/ files scanned, ` +
        `${APPROVED_SEAMS.length} approved seam(s) all still present, no unapproved seams.\n`,
    );
    return 0;
  }

  if (violations.length > 0) {
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
      '\nIf this is a deliberate, reviewed injection seam and not a leftover test seam, add it ' +
        'to APPROVED_SEAMS in scripts/di-seams/approved.ts with a reason for this exact site — ' +
        'do not broaden the pattern in model.ts to exempt it by name.\n\n',
    );
  }
  if (staleApprovals.length > 0) {
    process.stderr.write(
      `${staleApprovals.length} APPROVED_SEAMS entry(ies) no longer match anything in the ` +
        'tree (the site moved, was renamed, or was removed) — update or delete them in ' +
        'scripts/di-seams/approved.ts:\n',
    );
    for (const stale of staleApprovals) {
      process.stderr.write(`  ${stale.file} :: ${stale.field} :: typeof ${stale.target}\n`);
    }
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main());
}
