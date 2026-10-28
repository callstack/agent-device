import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'vitest';
import {
  annotationSymmetry,
  driftReport,
  renderPage,
  type MatrixData,
} from '../../scripts/capability-matrix/generate.ts';
import {
  MATRIX_SECTIONS,
  SCOPE_ROWS,
  type FactRow,
} from '../../scripts/capability-matrix/annotations.ts';
import { TARGETS } from '../../scripts/capability-matrix/targets.ts';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import type { CollectedMatrix } from '../../scripts/capability-matrix/run.ts';

// Guards `website/docs/docs/capabilities.md`. The page's cells come from the same
// runtime facts the `capabilities` command answers from (see
// scripts/capability-matrix/), so three things must stay true: the committed page
// matches what the code decides today, the annotations naming each row cover
// exactly the commands the registry derives from device facts, and every
// qualified cell still names facts that hold. All three are checked, so a
// capability cannot be added, renamed, or removed without an edit under
// scripts/capability-matrix/ and a regenerated page. The page's generation-date
// is provenance rather than a fact, so it is masked before the comparison — and
// negative tests pin what the mask does and does not hide: the version is a
// fact about the tree and stays compared.
//
// The facts are collected in a child process on purpose: the provider runtimes
// need `node:module` loader hooks to keep their third-party SDKs out of the run,
// and Vitest resolves a dynamic `import()` through its own module runner, which
// does not consult those hooks.
//
// Link and prose correctness on the rendered site belongs to `check:doc-links`
// and `check:doc-prose`; this guard checks the facts, the row coverage, and that
// each check still fails when its invariant breaks.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const DOCS_DIR = 'website/docs/docs';
const GENERATOR = 'scripts/capability-matrix/generate.ts';
const COLLECTOR = 'scripts/capability-matrix/run.ts';
const PAGE_PATH = 'website/docs/docs/capabilities.md';

function runScript(script: string): string {
  return execFileSync(process.execPath, ['--experimental-strip-types', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

const matrix: CollectedMatrix = JSON.parse(runScript(COLLECTOR)) as CollectedMatrix;
function toSets(
  list: Readonly<Record<string, readonly string[]>>,
): Map<string, ReadonlySet<string>> {
  return new Map(Object.entries(list).map(([id, items]) => [id, new Set(items)]));
}
const support = toSets(matrix.support);
const operations = toSets(matrix.operations);
const committed = fs.readFileSync(path.join(REPO_ROOT, PAGE_PATH), 'utf8');
// The real package version, so this guard also proves the committed page is
// stamped with the version the tree builds; the generated page must agree.
const packageVersion = (
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;
const data: MatrixData = {
  version: packageVersion,
  generatedAt: '2000-01-01',
  commands: matrix.commands,
  support,
  operations,
};
const factRows = MATRIX_SECTIONS.flatMap((section) => section.rows);
const linkedRows: ReadonlyArray<{ id: string; link: string }> = [...factRows, ...SCOPE_ROWS];

/** Rows whose commands disagree on at least one target, so a cell would hide a limit. */
function rowsThatSplit(
  rows: readonly FactRow[],
  targetSupport: ReadonlyMap<string, ReadonlySet<string>>,
) {
  return rows
    .filter((row) => row.commands.length > 1)
    .filter((row) => {
      const perCommand = new Set(
        row.commands.map((command) =>
          TARGETS.map((target) => targetSupport.get(target.id)?.has(command)).join(','),
        ),
      );
      return perCommand.size > 1;
    })
    .map((row) => row.id);
}

describe('capabilities page matches runtime facts', () => {
  test('the committed page matches the page the runtime facts generate', () => {
    // The generator's own comparison, so the check the docs lane runs is the one
    // proven here; a report names the first differing line.
    assert.equal(
      driftReport(committed, renderPage(data)),
      null,
      `${PAGE_PATH} is stale. Run \`pnpm generate:capabilities\` and commit the result.`,
    );
  });

  test('the generator command itself passes on the committed page', () => {
    // One subprocess through main(), so the exit code the docs lane trusts is proven
    // against the same file the guard reads.
    let failure: { status?: number } | null = null;
    try {
      runScript(GENERATOR);
    } catch (error) {
      failure = error as { status?: number };
    }
    assert.equal(failure, null, `The generator failed: ${failure?.status ?? 'unknown'}`);
  });

  test('drift detection proves itself', () => {
    // The committed page is current, so every mutation below must report drift —
    // including one inside the masked provenance line's surroundings.
    assert.notEqual(
      driftReport(committed.replace(/Yes \| Yes \| No/, 'Yes | No | No'), committed),
      null,
    );
    const dated = committed.replace(/generated \d{4}-\d{2}-\d{2}\./, 'generated 2000-01-01.');
    assert.equal(driftReport(dated, committed), null, 'the generation date is provenance');
    const versioned = committed.replace(
      /It covers agent-device [^,]+,/,
      'It covers agent-device 9.9.9,',
    );
    assert.notEqual(
      driftReport(versioned, committed),
      null,
      'a page stamped with another version than the tree must read as stale',
    );
    assert.notEqual(
      driftReport(
        committed.replace(/generated [^.]+\./, 'generated 2000-01-01 and hand edited.'),
        committed,
      ),
      null,
      'text appended to the provenance sentence must not be masked',
    );
    assert.notEqual(
      driftReport(committed.replace(/\n## Inspect and verify the UI/, ''), committed),
      null,
    );
  });

  test('row coverage proves itself', () => {
    const dropped = factRows.map((row) =>
      row.id === 'screenshot' ? { ...row, commands: [] } : row,
    );
    assert.deepEqual(annotationSymmetry(data.commands, dropped).unrowed, ['screenshot']);
    const renamed = factRows.map((row) =>
      row.id === 'screenshot' ? { ...row, commands: ['screenshot-renamed'] } : row,
    );
    assert.deepEqual(annotationSymmetry(data.commands, renamed).unknown, ['screenshot-renamed']);
  });

  test('a qualified cell fails generation when a fact it names stops holding', () => {
    // The iOS keyboard cell claims `keyboardDismiss` answers there. Refusing it
    // must fail the generator, not silently keep the stale sentence.
    const lost = new Map(operations);
    lost.set(
      'ios-sim',
      new Set(
        [...(operations.get('ios-sim') as Set<string>)].filter((op) => op !== 'keyboardDismiss'),
      ),
    );
    assert.throws(() => renderPage({ ...data, operations: lost }), /keyboardDismiss/);
    // And a refusal a cell names must fail the same way once the fact grants it.
    const gained = new Map(operations);
    gained.set(
      'ios-sim',
      new Set([...(operations.get('ios-sim') as Set<string>), 'keyboardStatus']),
    );
    assert.throws(() => renderPage({ ...data, operations: gained }), /keyboardStatus/);
  });

  test('a plain Yes cell fails generation when an advertised operation stops holding', () => {
    // The Android emulator keyboard cell is a plain Yes, so the row's advertised
    // operations are its proof: removing one operation while the command stays
    // admitted through another use must fail generation, not keep the Yes.
    for (const operation of ['keyboardStatus', 'keyboardDismiss', 'keyboardEnter']) {
      const lost = new Map(operations);
      lost.set(
        'android-emulator',
        new Set(
          [...(operations.get('android-emulator') as Set<string>)].filter((op) => op !== operation),
        ),
      );
      assert.throws(
        () => renderPage({ ...data, operations: lost }),
        new RegExp(`Cell "keyboard" x "android-emulator".*${operation}`, 's'),
        `losing "${operation}" while the keyboard command stays admitted must not render`,
      );
    }
  });

  test('a qualified cell fails generation when an operation behind its text stops holding', () => {
    // The Android clipboard cells qualify a plain Yes and name both operations
    // their text claims. Removing either one must fail generation, not silently
    // keep the build-dependent sentence on a target that now refuses it.
    for (const operation of ['readClipboard', 'writeClipboard']) {
      const lost = new Map(operations);
      lost.set(
        'android-emulator',
        new Set(
          [...(operations.get('android-emulator') as Set<string>)].filter((op) => op !== operation),
        ),
      );
      assert.throws(
        () => renderPage({ ...data, operations: lost }),
        new RegExp(`"android-emulator".*${operation}`, 's'),
        `losing "${operation}" while the clipboard command stays admitted must not render`,
      );
    }
    // A qualified cell accounts for the whole advertised set even where it
    // names nothing itself: the iOS device perf cell keeps the set whole by
    // omission, so dropping one operation while perf stays admitted through
    // its other uses must fail on the operation, not re-render the sentence.
    for (const operation of ['perfFrames', 'perfMemorySnapshot', 'perfProfileReport']) {
      const lost = new Map(operations);
      lost.set(
        'ios-device',
        new Set(
          [...(operations.get('ios-device') as Set<string>)].filter((op) => op !== operation),
        ),
      );
      assert.throws(
        () => renderPage({ ...data, operations: lost }),
        new RegExp(`"perf" x "ios-device".*${operation}`, 's'),
        `losing "${operation}" while the perf command stays admitted must not render`,
      );
    }
    // The hole the partition rule closes: the HarmonyOS perf cell refuses the
    // capture operations and admits the rest, so losing the admitted RSS
    // sample must fail generation even though perf stays admitted through
    // frames and the declared refusals all still hold.
    const lostRss = new Map(operations);
    lostRss.set(
      'harmonyos-emulator',
      new Set(
        [...(operations.get('harmonyos-emulator') as Set<string>)].filter(
          (op) => op !== 'perfMemorySample',
        ),
      ),
    );
    assert.throws(
      () => renderPage({ ...data, operations: lostRss }),
      /"perf" x "harmonyos-emulator".*perfMemorySample/s,
      'losing perfMemorySample on HarmonyOS must not keep the RSS-sample sentence',
    );
  });

  test('each row reports commands that no target splits', () => {
    // A cell answers Yes only when every command in the row runs there, so commands
    // that disagree on any target would hide a real limit inside a Yes/No cell.
    assert.deepEqual(rowsThatSplit(factRows, support), []);
    // The check catches the violation it names: two real commands that differ on
    // at least one target must be reported.
    const violating: FactRow = {
      id: 'synthetic-split',
      label: 'Synthetic',
      commands: ['clipboard', 'snapshot'],
      link: '/docs/snapshots',
    };
    assert.deepEqual(rowsThatSplit([violating], support), ['synthetic-split']);
  });

  test('every capability link points at a docs page that exists', () => {
    const broken = linkedRows
      .map((row) => ({ row, page: /^\/docs\/([^#]*)/.exec(row.link)?.[1] ?? '' }))
      .filter(({ page }) => !fs.existsSync(path.join(REPO_ROOT, DOCS_DIR, `${page}.md`)))
      .map(({ row, page }) => `${row.id}: /docs/${page}`);
    assert.deepEqual(
      broken,
      [],
      `Capability link(s) name no page under ${DOCS_DIR}: ${broken.join(', ')}`,
    );
  });

  test('every command a non-device capability names is a real CLI command', () => {
    const cli = new Set<string>(listCliCommandNames());
    const unknown = SCOPE_ROWS.flatMap((row) =>
      row.commands.filter((command) => !cli.has(command)).map((command) => `${row.id}: ${command}`),
    );
    assert.deepEqual(
      unknown,
      [],
      `Non-device capability row(s) name commands the CLI does not expose: ${unknown.join(', ')}. ` +
        `Update SCOPE_ROWS in scripts/capability-matrix/annotations.ts.`,
    );
  });

  test('the matrix answers for every target the generator declares', () => {
    const missing = TARGETS.filter((target) => !support.has(target.id)).map((target) => target.id);
    assert.deepEqual(missing, [], `No facts were collected for: ${missing.join(', ')}`);
  });

  test('the page renders every declared target into a column', () => {
    const rendered = renderPage(data);
    const headers = rendered
      .split('\n')
      .filter((line) => line.startsWith('| Capability and reference'));
    for (const target of TARGETS) {
      // A target either gets its own column header or shares one, so its label
      // must appear among the labels of some header line.
      assert.ok(
        headers.some((line) => line.includes(target.label)),
        `Target "${target.id}" (label "${target.label}") is not named in any column header on the page.`,
      );
    }
    // The committed page carries the real stamp, not the mask.
    assert.match(
      committed,
      /^It covers agent-device \d+\.\d+\.\d+[^,\n]*, generated \d{4}-\d{2}-\d{2}\.$/m,
    );
  });
});
