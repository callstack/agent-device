import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { run } from './run.ts';
import {
  COVERAGE_STAMP_FILE,
  beginCoverageRun,
  finishCoverageRun,
  type CoverageConfig,
  type RunSelection,
} from './stamp.ts';
import {
  beginStderrCapture,
  beginStdoutCapture,
} from '../../src/__tests__/test-utils/stream-capture.ts';

// The verdict is what CI enforces on a PR, so these run the real entrypoint against a real git
// repo, a real fallow, a real stamp, and hand-built coverage reports — a stub of fallow could not
// prove that rename-aware attribution, the stamp, and the threshold agree.

let repo: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

function write(rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** What the fixture's coverage pass was told to instrument, and what the stamp records with it. */
const COVERAGE_CONFIG: CoverageConfig = { include: ['src/**/*.ts'], exclude: [] };

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
 * Writes the Istanbul map one coverage run would have left for `files`. A record is written for every
 * entry; `absent` is how the eligible-but-unrecorded case is built — the file exists in the tree, the
 * stamp says the run saw it, and the map holds no counters for it.
 */
function writeCoverage(files: Readonly<Record<string, CoverageOptions | 'absent'>>): void {
  const map: Record<string, unknown> = {};
  for (const [file, options] of Object.entries(files)) {
    if (options !== 'absent') map[path.join(repo, file)] = istanbulRecord(file, options);
  }
  write('coverage/coverage-istanbul.json', JSON.stringify(map));
}

/** What `pnpm test:coverage` leaves beside its reports: the stamp naming the run that wrote them. */
function writeStamp(runSelection: RunSelection = 'full'): void {
  const outcome = finishCoverageRun(
    beginCoverageRun(repo),
    path.join(repo, 'coverage'),
    COVERAGE_CONFIG,
    runSelection,
  );
  assert.ok(
    'written' in outcome,
    'expected a pass over an unmoved fixture tree to write its stamp',
  );
}

function commit(message: string): void {
  git('add', '-A');
  git('commit', '-q', '-m', message);
}

// The entrypoint writes reports and reads the job summary, so each case needs the stream capture as
// well as the exit code: `code: 0` with a "no trustworthy verdict" body is the failure mode here.
function capture(fn: () => number): { code: number; out: string } {
  const stdoutCapture = beginStdoutCapture();
  const stderrCapture = beginStderrCapture();
  try {
    const code = fn();
    return { code, out: stdoutCapture.read() + stderrCapture.read() };
  } finally {
    stdoutCapture.restore();
    stderrCapture.restore();
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
  // Same as this repository's own ignore rules: the reports and the stamp beside them live outside the
  // tree the stamp describes, which is what lets writing them leave the hash it just computed alone.
  write('.gitignore', 'coverage/\n');
  // Same shape as the repository's own config: one per-function CRAP exemption, plus a stale one
  // whose function no longer exists, to prove the report states the scope fallow actually applied.
  write(
    '.fallowrc.json',
    `${JSON.stringify(
      {
        health: {
          maxCrap: 0,
          thresholdOverrides: [
            {
              files: ['src/exempt.ts'],
              functions: ['score'],
              maxCrap: 90,
              reason: 'Runs on a worker thread the coverage map never sees.',
            },
            {
              files: ['src/gone.ts'],
              functions: ['oldWorkerEntry'],
              maxCrap: 90,
              reason: 'This worker moved out.',
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
  writeStamp();

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
  writeStamp();

  const { code, out } = checkOnActions(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /1 touched function\(s\) at or above 30/);
  assert.match(out, /\| `src\/debt\.ts:1` score \| 56\.0 \| 7 \| 0% \|/);
  assert.match(out, /::warning file=src\/debt\.ts,line=1,title=CRAP 56\.0/);
});

test("the score of an untouched file is not this change's verdict", () => {
  // Half of this is the exit code: the map holds `src/debt.ts` at CRAP 42 and the run is still green,
  // which only happens if fallow filtered its findings by this diff rather than scoring the repo.
  // The diff reaches fallow on stdin and never through the checkout, so seed the artifact an
  // earlier release wrote with a scope charging the untouched debt file: a gate that read that
  // file again would report `src/debt.ts:1` at 42 and exit 1, and one that rewrote it would leave
  // different content behind. Scoping on stdin does neither.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit, debt left alone');
  writeStamp();
  const staleDiff = [
    'diff --git a/src/debt.ts b/src/debt.ts',
    '--- a/src/debt.ts',
    '+++ b/src/debt.ts',
    '@@ -1,0 +1,1 @@',
    '+export const planted = 1;',
  ].join('\n');
  write('coverage/fallow-crap.diff', staleDiff);

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.doesNotMatch(out, /src\/debt\.ts:1/);
  assert.equal(fs.readFileSync(path.join(repo, 'coverage/fallow-crap.diff'), 'utf8'), staleDiff);
});

test('a pure rename does not touch the functions that moved with the file', () => {
  writeCoverage({ 'src/moved.ts': {}, 'src/clean.ts': { hits: 4 } });
  git('mv', 'src/debt.ts', 'src/moved.ts');
  commit('pure move');
  writeStamp();

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.doesNotMatch(out, /src\/moved\.ts:1/);
});

test('a rename that also edits the body owes the edited lines', () => {
  git('mv', 'src/debt.ts', 'src/moved.ts');
  commit('move');
  write(
    'src/moved.ts',
    DEBT.replace('  return total;', '  if (a === b) {\n    total += 2;\n  }\n  return total;'),
  );
  commit('then edit it');
  writeCoverage({ 'src/moved.ts': { span: [1, 19] }, 'src/clean.ts': { hits: 4 } });
  writeStamp();

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /\| `src\/moved\.ts:1` score \| 56\.0 \| 7 \| 0% \|/);
});

test('deleting lines from a debt function does not charge the function that survives them', () => {
  // Measured, not assumed: fallow's diff-scoping index holds added lines only, so a hunk that is
  // nothing but removals contributes no line to intersect a function's span with, and this run
  // agrees rather than overriding it — the same reason the whole-file and pure-rename exemptions
  // exist. The residual is deliberate and not free: a deletion can even raise a surviving
  // function's CRAP by removing lines that used to be covered, and that new debt shows up only in
  // `--all`. Pinned so a change to either layer's scoping has to say so.
  write('src/debt.ts', DEBT.replace('    total += 1;\n', ''));
  commit('delete a line inside the debt function');
  writeCoverage({ 'src/debt.ts': { span: [1, 13] }, 'src/clean.ts': { hits: 4 } });
  writeStamp();

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
  write(
    'src/debt.ts',
    `${DEBT.replace('    total += 1;\n', '')}\nexport const helper = 2;\nexport const extra = 3;\n`,
  );
  commit('drop a line inside the function, add two below it');
  writeCoverage({ 'src/debt.ts': { span: [1, 13] }, 'src/clean.ts': { hits: 4 } });
  writeStamp();

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
  write('src/debt.ts', TRIVIAL);
  commit('delete the debt function, leave the map recording it');
  writeCoverage({ 'src/debt.ts': { span: [1, 14] }, 'src/clean.ts': { hits: 4 } });
  writeStamp();

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.match(out, /no touched function\(s\) at or above 30/);
  const backlog = check(['--all']);
  assert.equal(backlog.code, 0);
  assert.match(backlog.out, /no function\(s\) at or above 30/);
});

test('a touched file the sanitizer dropped as corrupt yields no verdict', () => {
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('edit the file with impossible counts');
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { corrupt: true } });
  writeStamp();

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /dropped from the map for impossible counts.*`src\/clean\.ts`/s);
});

test('a touched file coverage never instruments is listed, not blocked on', () => {
  // `scripts/**` is outside the run's include, so no re-run would measure it: blocking on the
  // estimate would refuse every tooling PR, and staying silent would hide the 42.
  write('scripts/tool.ts', DEBT);
  commit('add a tooling file coverage does not instrument');
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  writeStamp();

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.match(out, /no touched function\(s\) at or above 30/);
  assert.match(out, /Not measured, and not blocking.*`scripts\/tool\.ts:1` score \(CRAP 42\.0\)/s);
});

test('a touched file the config instruments and the map omits yields no verdict', () => {
  // The stamp vouches for a tree that holds `src/new.ts`, so the run that wrote it was told to
  // instrument the file and recorded nothing: the map cannot answer for this change.
  write('src/new.ts', TRIVIAL);
  commit('add a file the map is missing');
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 }, 'src/new.ts': 'absent' });
  writeStamp();

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /no record in the coverage map\*\*: `src\/new\.ts`/);
});

// The provider reads all four spellings as one keyword, so none of them may be held against a run. The
// JSDoc row is the one that catches the comment's own delimiter: oxc reports a block comment's value with
// the `*` a `/**` opener introduced still on it, which the provider has stripped before matching.
for (const [spelling, pragma] of [
  ['c8', '/* c8 ignore file */'],
  ['c8 as JSDoc', '/** c8 ignore file */'],
  ['v8', '/* v8 ignore file */'],
  ['istanbul', '/* istanbul ignore file */'],
  ['node:coverage', '// node:coverage ignore file'],
]) {
  test(`a file whose source says ${spelling} ignore file is not held against the run`, () => {
    // No `pnpm test:coverage` run ever records it, so refusing here would block the file forever.
    write('src/worker-entry.ts', `${pragma}\n${DEBT}`);
    commit('add a file that declares itself outside coverage');
    writeCoverage({
      'src/debt.ts': {},
      'src/clean.ts': { hits: 4 },
      'src/worker-entry.ts': 'absent',
    });
    writeStamp();

    const { code, out } = check(['--base', HEADS[0]!]);

    assert.equal(code, 0);
    assert.match(out, /Not measured, and not blocking.*`src\/worker-entry\.ts:2` score/s);
  });
}

test('a multi-line JSDoc pragma does not exempt a file, because the provider does not exempt it either', () => {
  // The question this row settles: the provider strips one opener and one closer from the comment's own
  // text and then anchors the keyword to what remains, so the `*` that begins the pragma's line in this
  // spelling still stands between the whitespace and the keyword, and the file stays in its counts.
  // Exempting it here would hide the file from the check for a record the provider always writes.
  write('src/worker-entry.ts', `/**\n * c8 ignore file\n */\n${DEBT}`);
  commit('add a file whose pragma is a multi-line JSDoc block');
  writeCoverage({
    'src/debt.ts': {},
    'src/clean.ts': { hits: 4 },
    'src/worker-entry.ts': 'absent',
  });
  writeStamp();

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no record in the coverage map\*\*: `src\/worker-entry\.ts`/);
});

test('a pragma-shaped string literal does not exempt a file from the map check', () => {
  // The provider reads the hint from comment tokens, so text that only looks like one inside a string
  // must not exempt the file: doing so hides the unmeasured-file case this check exists to name.
  write('src/mentions.ts', 'export const sample = "/* c8 ignore file */";\n');
  commit('add a file that merely mentions the pragma');
  writeCoverage({
    'src/debt.ts': {},
    'src/clean.ts': { hits: 4 },
    'src/mentions.ts': 'absent',
  });
  writeStamp();

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no record in the coverage map\*\*: `src\/mentions\.ts`/);
});

test('a touched file the working tree no longer holds is not held against the run', () => {
  // `base...HEAD` still names a file deleted without committing, while the stamp's hash reads the disk,
  // so a re-run verifies with no record for that file at all: either per-file question would survive
  // every re-run, and this one would name counts a re-run repeats.
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  write('src/new.ts', TRIVIAL);
  commit('add a file, then delete it without committing');
  writeCoverage({
    'src/debt.ts': {},
    'src/clean.ts': { hits: 4 },
    'src/new.ts': { corrupt: true },
  });
  fs.rmSync(path.join(repo, 'src/new.ts'));
  writeStamp();

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.match(out, /no touched function\(s\) at or above 30/);
});

test('a committed symlink to a directory is not read as a touched file', () => {
  // The diff of a committed symlink (`helper-tests/Sources -> ../helper`) carries its target
  // path as one added line, so the file reaches the touched list by its lines alone. The working
  // tree holds a directory behind it, so reading it as source dies on EISDIR before any verdict
  // exists — the object mode in the diff header is what keeps it off the list.
  fs.mkdirSync(path.join(repo, 'helper-tests'), { recursive: true });
  write('helper/Helper.swift', 'func helper() {}\n');
  fs.symlinkSync('../helper', path.join(repo, 'helper-tests/Sources'));
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('add a symlink to a directory');
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  writeStamp();

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.match(out, /no touched function\(s\) at or above 30/);
});

test('coverage written without a stamp is not trustworthy', () => {
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /no coverage-run-stamp\.json.*which run wrote it/s);
});

test('a coverage run from before the last commit yields no verdict', () => {
  // The stamp is written against the commit coverage finished on, so committing after the run —
  // a rebase, a merge, a follow-up fix — is exactly what the reader must be told about.
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  writeStamp();
  commit('commit after coverage ran');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /HEAD moved since the coverage run wrote its stamp/);
});

test('a function body replaced in place after the run yields no verdict', () => {
  // The case file lists and function spans cannot catch: the counters are real, the code they
  // measured is gone, and the report still reads as a clean answer about the new body.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  writeStamp();
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 3;\n`);

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /this checkout changed since the coverage run wrote its stamp/);
});

for (const narrowed of ['project', 'files', 'test-name', 'shard', 'test-ids'] as const) {
  test(`a coverage run that narrowed the lane (${narrowed}) yields no verdict`, () => {
    // A narrowed pass still reports every file the config includes, mostly with no counters, so the
    // functions its missing tests would have covered arrive as untested. Refusing it is the only
    // answer that does not blame the author for a gap the run itself created.
    write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
    commit('clean edit');
    writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
    writeStamp(narrowed);

    const { code, out } = check(['--base', HEADS[0]!]);

    assert.equal(code, 1);
    assert.match(out, /no trustworthy verdict/i);
    assert.match(out, /did not exercise the whole coverage lane/);
  });
}

test('an unreadable stamp yields no verdict', () => {
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  writeStamp();
  write(`coverage/${COVERAGE_STAMP_FILE}`, '{"schemaVersion":1}');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /not a stamp this check can read: head is not a commit/);
});

test('a coverage map recorded in another checkout is refused', () => {
  // Two checkouts of one commit share HEAD and bytes, so no stamp can tell them apart. Vitest writes
  // the map's keys absolute, so relativizing them is what names the other root.
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  writeStamp();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-crap-other-'));
  writeCoverage({ 'src/debt.ts': {} });
  write(
    'coverage/coverage-istanbul.json',
    fs
      .readFileSync(path.join(repo, 'coverage/coverage-istanbul.json'), 'utf8')
      .split(repo)
      .join(elsewhere),
  );
  fs.rmSync(elsewhere, { recursive: true, force: true });

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /records files outside this checkout/);
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

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict.*coverage-istanbul\.json/s);
  assert.match(out, /not a count object/);
});

test('--all reports the whole-repo backlog and stays green', () => {
  // Report-only scope asks nothing of a diff, so it asks nothing of a stamp either: `main`'s CI has
  // one coverage pass and no base to compare against.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit, repo debt left in place');

  const { code, out } = check(['--all']);

  assert.equal(code, 0);
  assert.match(out, /Coverage-based CRAP \(report-only\): 1 function\(s\) at or above 30/);
  assert.match(out, /\| `src\/debt\.ts:1` score \| 42\.0 \| 6 \| 0% \|/);
});

test('the report lists the per-function exemptions fallow applied, and the stale ones', () => {
  write('src/exempt.ts', DEBT);
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('edit a file while an exempt file carries the same debt');
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 }, 'src/exempt.ts': {} });
  writeStamp();

  const { code, out } = check(['--all']);

  assert.equal(code, 0);
  // The override names one function under a ceiling growth can breach — the file-wide 1e12 it
  // replaces admitted neither — and the override whose function is gone is named for deletion.
  assert.match(
    out,
    /CRAP exemptions from `\.fallowrc\.json` \(1 applied\).*one function only, so growth above it still blocks/s,
  );
  assert.match(
    out,
    /- `src\/exempt\.ts` `score` — ceiling 90: Runs on a worker thread the coverage map never sees\./,
  );
  assert.match(
    out,
    /No longer needed by any function and can be deleted: an override \(“This worker moved out\.”\)/,
  );
  assert.doesNotMatch(out, /\| `src\/exempt\.ts:1`/);
});
