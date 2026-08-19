import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';

// The Size workflow measures the base commit with the PR's reporter, so it copies the reporter
// out of the tree before `git checkout` moves under it. That copy has to carry the reporter's
// whole relative-import closure: when the closure grew to a second file and the step still copied
// one, the base measurement died with ERR_MODULE_NOT_FOUND — after every deterministic gate had
// passed, because nothing local reproduces the copy. This test is that reproduction.

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = 'scripts/size-report.mjs';
const WORKFLOW = '.github/workflows/size.yml';

/** Repo-relative paths the entry reaches through relative (`./`, `../`) static imports. */
function relativeImportClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:import|export)[^'"\n]*['"](\.[^'"]+)['"]/g,
    )) {
      const resolved = path.posix.join(path.posix.dirname(file), match[1] as string);
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

test('the reporter is more than one file, so the workflow may not preserve it as one file', () => {
  const closure = relativeImportClosure(ENTRY);
  const workflow = readFileSync(path.join(ROOT, WORKFLOW), 'utf8');
  const preserve = workflow.slice(
    workflow.indexOf('- name: Preserve report script'),
    workflow.indexOf('- name: Restore base dist cache'),
  );
  expect(preserve).not.toEqual('');

  // Copying the whole directory covers any closure inside it, including files a later split adds.
  const copiesDirectory = /cp\s+-R\s+scripts\s/.test(preserve);
  const outside = closure.filter((file) => !file.startsWith('scripts/'));
  if (copiesDirectory) {
    expect(outside, 'a closure member outside scripts/ is not covered by copying scripts/').toEqual(
      [],
    );
    return;
  }
  // Otherwise every member must be named explicitly — the shape that already broke once.
  for (const file of closure) {
    expect(preserve, `the preserve step must copy ${file}`).toContain(file);
  }
});

test('the workflow runs the preserved copy, not the checked-out tree', () => {
  const workflow = readFileSync(path.join(ROOT, WORKFLOW), 'utf8');
  const base = workflow.slice(
    workflow.indexOf('- name: Measure base size'),
    workflow.indexOf('- name: Save base dist cache'),
  );
  // Measuring the base with `pnpm size` would run the base commit's own reporter, so base and PR
  // would be measured by different instruments — the reason the copy exists at all.
  expect(base).toMatch(/node \/tmp\/agent-device-size-report\/size-report\.mjs/);
  expect(base).not.toMatch(/pnpm size/);
});
