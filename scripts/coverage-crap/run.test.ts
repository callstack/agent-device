import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { run } from './run.ts';

// The verdict is what CI enforces on a PR, so these run the real entrypoint against a real git
// repo, a real fallow and hand-built coverage reports — a stub of fallow could not prove that
// rename-aware attribution, the map-completeness cross-check and the threshold agree.

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

function write(rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Cyclomatic 6, so an untested copy scores CRAP 42 and one added decision lifts it to 56. */
const DEBT = `export function score(mode: string, a: number, b: number, c: number): number {
  let total = 0;
  if (mode === 'a') {
    total += a;
  } else if (mode === 'b') {
    total += b;
  } else if (mode === 'c') {
    total += c;
  }
  if (a > 0 && b > 0) {
    total += 1;
  }
  return total;
}
`;

const TRIVIAL = 'export const trivial = 1;\n';

type CoverageOptions = Readonly<{
  /** Function start/end lines, for the cases where the code moved. */
  span?: readonly [number, number];
  /** Function count: 0 leaves the function untested. */
  hits?: number;
  /** Emit a count no execution can produce, which the sanitizer drops with the whole record. */
  corrupt?: boolean;
}>;

function istanbulRecord(file: string, options: CoverageOptions): Record<string, unknown> {
  const [from, to] = options.span ?? [1, 16];
  const line = (n: number) => ({ line: n, column: 0 });
  return {
    path: path.join(repo, file),
    statementMap: { 0: { start: line(from), end: line(to) } },
    fnMap: {
      0: {
        name: 'score',
        decl: { start: line(from), end: line(from) },
        loc: { start: line(from), end: line(to) },
        line: from,
      },
    },
    branchMap: {},
    s: { 0: options.corrupt ? -1 : (options.hits ?? 0) },
    f: { 0: options.hits ?? 0 },
    b: {},
  };
}

/**
 * Writes both reports of one coverage run for `files`, so the run stays self-consistent unless a
 * test says otherwise. `lcovOnly` is how the partial-map cases are built: the run enumerated the
 * file, and the Istanbul map has no record of it.
 */
function writeCoverage(
  files: Readonly<Record<string, CoverageOptions | 'lcov-only' | 'map-only'>>,
): void {
  const map: Record<string, unknown> = {};
  const lcov: string[] = [];
  for (const [file, options] of Object.entries(files)) {
    if (options !== 'map-only') {
      lcov.push(`SF:${file}\nDA:1,${options === 'lcov-only' ? 0 : 1}\nend_of_record\n`);
    }
    if (options !== 'lcov-only') map[path.join(repo, file)] = istanbulRecord(file, options);
  }
  write('coverage/coverage-istanbul.json', JSON.stringify(map));
  write('coverage/lcov.info', lcov.join(''));
}

function commit(message: string): void {
  git('add', '-A');
  git('commit', '-q', '-m', message);
}

// The entrypoint writes reports and reads the job summary, so each case needs the stream capture as
// well as the exit code: `code: 0` with a "no trustworthy verdict" body is the failure mode here.
//
// Restoring means putting back the descriptor, not a function of the same name. `process.stdout`
// inherits `write` from its prototype, so a saved-and-reassigned property would leave an own
// property shadowing the prototype's, and `bind` would have handed back a bound copy no later
// `delete` could undo.
type CapturedStream = Readonly<{
  target: NodeJS.WriteStream;
  key: 'write';
  descriptor: PropertyDescriptor | undefined;
}>;

function capture(fn: () => number): { code: number; out: string } {
  const chunks: string[] = [];
  const restore: CapturedStream[] = [];
  const collect = (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  for (const target of [process.stdout, process.stderr]) {
    restore.push({
      target,
      key: 'write',
      descriptor: Object.getOwnPropertyDescriptor(target, 'write'),
    });
    Object.defineProperty(target, 'write', {
      value: collect,
      writable: true,
      configurable: true,
    });
  }
  try {
    return { code: fn(), out: chunks.join('') };
  } finally {
    for (const { target, key, descriptor } of restore) {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete (target as unknown as Record<string, unknown>)[key];
    }
  }
}

const HEADS = ['main', 'feature'];

// The real CI job sets these, and `run()` honours both: it appends its report to the step summary
// file and emits annotations. A fixture repo is not a CI job, so leaving them inherited wrote fake
// debt tables into the real job's summary while this suite ran. `checkOnActions` opts one case back
// in, the only case where the annotation format is what is under test.
const ACTIONS_ENV_KEYS = ['GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY'] as const;
let savedActionsEnv: Record<string, string | undefined> = {};

function check(args: readonly string[]): { code: number; out: string } {
  return capture(() => run(args, repo));
}

/** Annotations are a CI-surface output, so the case that reads them has to stand in for Actions. */
function checkOnActions(args: readonly string[]): { code: number; out: string } {
  process.env.GITHUB_ACTIONS = 'true';
  try {
    return check(args);
  } finally {
    if (savedActionsEnv.GITHUB_ACTIONS === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = savedActionsEnv.GITHUB_ACTIONS;
  }
}

beforeEach(() => {
  savedActionsEnv = {};
  for (const key of ACTIONS_ENV_KEYS) {
    savedActionsEnv[key] = process.env[key];
    delete process.env[key];
  }
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-crap-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'diff.renames', 'false');
  git('checkout', '-q', '-b', HEADS[0]!);
  // Same shape as the repository's own config: CRAP only, plus one file-wide exemption to prove
  // the report reads its scope from the config rather than restating a list.
  write(
    'fallow-crap.json',
    `${JSON.stringify(
      {
        rules: { 'complexity-cyclomatic': 'off', 'complexity-cognitive': 'off' },
        health: {
          thresholdOverrides: [
            {
              files: ['src/exempt.ts'],
              maxCrap: 1e12,
              reason: 'Runs on a worker thread the coverage map never sees.',
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  write('src/debt.ts', DEBT);
  write('src/clean.ts', TRIVIAL);
  commit('base');
  git('checkout', '-q', '-b', HEADS[1]!);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedActionsEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('a change that touches no function at or above the threshold passes', () => {
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.match(
    out,
    /Coverage-based CRAP \(blocking at 30\): no touched function\(s\) at or above 30/,
  );
});

test('editing a function that already scores too high blocks, even though the score is not new', () => {
  writeCoverage({ 'src/debt.ts': { span: [1, 19] }, 'src/clean.ts': { hits: 4 } });
  write(
    'src/debt.ts',
    DEBT.replace('  return total;', '  if (a === b) {\n    total += 2;\n  }\n  return total;'),
  );
  commit('edit the debt');

  const { code, out } = checkOnActions(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /1 touched function\(s\) at or above 30/);
  assert.match(out, /\| `src\/debt\.ts:1` score \| 56\.0 \| 7 \| 0% \|/);
  assert.match(out, /::warning file=src\/debt\.ts,line=1,title=CRAP 56\.0/);
});

test("the score of an untouched file is not this change's verdict", () => {
  // Half of this is the exit code: the map holds `src/debt.ts` at CRAP 42 and the run is still green,
  // which only happens if fallow filtered its findings by this diff rather than scoring the repo.
  // The other half is that diff itself, since a flag that silently went missing would score
  // everything and a diff built from the wrong range would look just as clean.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit, debt left alone');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.doesNotMatch(out, /src\/debt\.ts:1/);
  const scoped = fs.readFileSync(path.join(repo, 'coverage/fallow-crap.diff'), 'utf8');
  assert.match(scoped, /^\+\+\+ b\/src\/clean\.ts$/m);
  assert.doesNotMatch(scoped, /^\+\+\+ b\/src\/debt\.ts$/m);
});

test('a pure rename does not touch the functions that moved with the file', () => {
  writeCoverage({ 'src/moved.ts': {}, 'src/clean.ts': { hits: 4 } });
  git('mv', 'src/debt.ts', 'src/moved.ts');
  commit('pure move');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.doesNotMatch(out, /src\/moved\.ts:1/);
});

test('a rename that also edits the body owes the edited lines', () => {
  writeCoverage({ 'src/moved.ts': { span: [1, 19] }, 'src/clean.ts': { hits: 4 } });
  git('mv', 'src/debt.ts', 'src/moved.ts');
  commit('move');
  write(
    'src/moved.ts',
    DEBT.replace('  return total;', '  if (a === b) {\n    total += 2;\n  }\n  return total;'),
  );
  commit('then edit it');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /\| `src\/moved\.ts:1` score \| 56\.0 \| 7 \| 0% \|/);
});

test('deleting lines from a debt function does not charge the function that survives them', () => {
  // Measured, not assumed: fallow's `--diff-file` index holds added lines only, so a hunk that is
  // nothing but removals contributes no line to intersect a function's span with, and this run
  // agrees rather than overriding it — the same reason the whole-file and pure-rename exemptions
  // exist. The residual is deliberate and not free: a deletion can even raise a surviving
  // function's CRAP by removing lines that used to be covered, and that new debt shows up only in
  // `--all`. Pinned so a change to either layer's scoping has to say so.
  writeCoverage({ 'src/debt.ts': { span: [1, 13] }, 'src/clean.ts': { hits: 4 } });
  write('src/debt.ts', DEBT.replace('    total += 1;\n', ''));
  commit('delete a line inside the debt function');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.match(out, /no touched function\(s\) at or above 30/);
  // Not a vacuous pass: the same map, scored without the diff, does hold this function at 42.
  const backlog = check(['--all']);
  assert.equal(backlog.code, 0);
  assert.match(backlog.out, /\| `src\/debt\.ts:1` score \| 42\.0 \| 6 \| 0% \|/);
});

test('lines added below a debt function do not charge it, though the diff also deleted one inside', () => {
  // The per-span half of the boundary: scoping is per function span, not per file, so a module is
  // not charged for the debt it merely contains. `score` loses one line here and the file gains two
  // below it, and because none of the added lines land inside the span, none of them charge it.
  writeCoverage({ 'src/debt.ts': { span: [1, 13] }, 'src/clean.ts': { hits: 4 } });
  write(
    'src/debt.ts',
    `${DEBT.replace('    total += 1;\n', '')}\nexport const helper = 2;\nexport const extra = 3;\n`,
  );
  commit('drop a line inside the function, add two below it');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.doesNotMatch(out, /`src\/debt\.ts:1` score/);
  const backlog = check(['--all']);
  assert.match(backlog.out, /\| `src\/debt\.ts:1` score \| 42\.0 \| 6 \| 0% \|/);
});

test('a deleted function takes its score with it, out of both scopes', () => {
  // The stronger fixture, and the reason the exemption is structural rather than the diff filter
  // again: the map still records `score` at 42 from a coverage run that predates the deletion, yet
  // neither scope reports it, because scoring walks the source and the source no longer holds the
  // function. The two cases above pin debt that IS scored and is held back by scoping; this one
  // pins debt that no longer exists in either scope even while the map claims it.
  writeCoverage({ 'src/debt.ts': { span: [1, 14] }, 'src/clean.ts': { hits: 4 } });
  write('src/debt.ts', TRIVIAL);
  commit('delete the debt function, leave the map recording it');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.match(out, /no touched function\(s\) at or above 30/);
  const backlog = check(['--all']);
  assert.equal(backlog.code, 0);
  assert.match(backlog.out, /no function\(s\) at or above 30/);
});

test('a touched file the sanitizer dropped as corrupt yields no verdict', () => {
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { corrupt: true } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('edit the file with impossible counts');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /dropped from the map for impossible counts.*`src\/clean\.ts`/s);
});

test('a touched file the coverage run enumerated but the map never recorded yields no verdict', () => {
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 }, 'src/new.ts': 'lcov-only' });
  write('src/new.ts', TRIVIAL);
  commit('add a file the map is missing');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /no record in the coverage map\*\*: `src\/new\.ts`/);
});

test('a map with fewer files than the run enumerated yields no verdict for any touched function', () => {
  // The gap is in an untouched file: the touched edit is clean, so only the cross-check between
  // the two reports of one coverage run can say this map does not describe the commit.
  writeCoverage({
    'src/debt.ts': {},
    'src/clean.ts': { hits: 4 },
    'src/unrecorded.ts': 'lcov-only',
  });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit against a stale map');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /fewer files than the same run enumerated\*\* \(2 recorded, 3 enumerated\)/);
});

test('no lcov report is a named gap, not a pass', () => {
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  fs.rmSync(path.join(repo, 'coverage/lcov.info'));

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /no usable lcov report lists the files the coverage run measured/);
});

test('an lcov that lists no files is a gap too, not a trivially-complete enumeration', () => {
  // A truncated write leaves the file present but empty. Reading it as "enumerated zero files" would
  // satisfy every completeness check at once and pass a PR nothing measured, so it reads as missing.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  write('coverage/lcov.info', 'TN:\n');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /no usable lcov report lists the files the coverage run measured/);
});

test('a debt finding and a missing enumeration together still say the report cannot answer', () => {
  // Both are true at once: there is debt to show, and no record of what was measured. Showing the
  // count would let a report that cannot answer its own question read as an answered one, so the
  // gap wins the headline either way.
  writeCoverage({ 'src/debt.ts': { span: [1, 19] }, 'src/clean.ts': { hits: 4 } });
  write(
    'src/debt.ts',
    DEBT.replace('  return total;', '  if (a === b) {\n    total += 2;\n  }\n  return total;'),
  );
  commit('edit the debt, then lose lcov');
  fs.rmSync(path.join(repo, 'coverage/lcov.info'));

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no usable lcov report lists the files the coverage run measured/);
  assert.doesNotMatch(out, /1 touched function\(s\) at or above 30/);
});

test('a touched function the map predates is estimated, and an estimate is no verdict', () => {
  // `src/debt.ts` IS in the map, which records only `score`, so appending a second complex function
  // leaves the map older than the code and fallow scores the new one from complexity alone. Real
  // fallow produces exactly that report here, which is what the gate refuses to score from.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/debt.ts', `${DEBT}${DEBT.replace('score', 'added')}`);
  commit('append a complex function to a file the map records');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /estimated from complexity alone\*\*: `src\/debt\.ts:15` added/);
});

test('an estimate in a file coverage never instruments is listed, not blocked on', () => {
  // `scripts/**` is outside both coverage roots, so no re-run would measure it: blocking on the
  // estimate would refuse every tooling PR, and staying silent would hide the 42.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('scripts/tool.ts', DEBT);
  commit('add a tooling file coverage does not instrument');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.match(out, /no touched function\(s\) at or above 30/);
  assert.match(out, /Not measured, and not blocking.*`scripts\/tool\.ts:1` score \(CRAP 42\.0\)/s);
});

test('a missing coverage map says so with the command to run', () => {
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit with no coverage');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict.*coverage-istanbul\.json.*`pnpm test:coverage`/s);
});

test('a coverage map that is not a counters object says so instead of reporting no findings', () => {
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  write('coverage/coverage-istanbul.json', '{"src/clean.ts": {"s": []}}');
  write('coverage/lcov.info', 'SF:src/clean.ts\nDA:1,1\nend_of_record\n');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict.*coverage-istanbul\.json/s);
  assert.match(out, /not a count object/);
});

test('--all reports the whole-repo backlog and stays green', () => {
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit, repo debt left in place');

  const { code, out } = check(['--all']);

  assert.equal(code, 0);
  assert.match(out, /Coverage-based CRAP \(report-only\): 1 function\(s\) at or above 30/);
  assert.match(out, /\| `src\/debt\.ts:1` score \| 42\.0 \| 6 \| 0% \|/);
});

test('the report lists the file-wide exemptions with the scope they actually have', () => {
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/exempt.ts', DEBT);
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('edit a file while an exempt file carries the same debt');

  const { code, out } = check(['--all']);

  assert.equal(code, 0);
  // The exemption holds for every function in the file, which is what the reader needs to know.
  assert.match(
    out,
    /File-wide CRAP exemptions in `fallow-crap\.json` \(1\).*exempts every function in its files, including helpers Node could test/s,
  );
  assert.match(out, /- `src\/exempt\.ts` — `maxCrap: 1e\+12`: Runs on a worker thread/);
  assert.doesNotMatch(out, /\| `src\/exempt\.ts:1`/);
});
