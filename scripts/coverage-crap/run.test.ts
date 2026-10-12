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
function capture(fn: () => number): { code: number; out: string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const collect = (chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  process.stdout.write = collect as typeof process.stdout.write;
  process.stderr.write = collect as typeof process.stderr.write;
  try {
    return { code: fn(), out: chunks.join('') };
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalErr;
  }
}

function check(args: readonly string[], fallowBin?: string): { code: number; out: string } {
  return capture(() => run(args, repo, fallowBin));
}

/**
 * A fallow that reports what a case says rather than what it measures, for the two claims the real
 * binary cannot make on command: that the blocking exit follows a reported finding, and that a
 * no-verdict branch wins over a finding that asks to be ignored. Also the only way to see which
 * flags this gate passes.
 */
const STANDIN = path.join(import.meta.dirname, 'fallow-stand-in.fixture.mjs');

/** Tells the stand-in which finding to report, in fallow's own report shape. */
function standInReports(finding: Record<string, unknown>): void {
  write('coverage/fallow-stand-in.json', JSON.stringify([finding]));
}

function standInFlags(): { diffFile: string | null; coverage: string | null } {
  return JSON.parse(
    fs.readFileSync(path.join(repo, 'coverage/fallow-stand-in-called-with.json'), 'utf8'),
  ) as { diffFile: string | null; coverage: string | null };
}

/** Annotations are a CI-surface output, so the case that reads them has to stand in for Actions. */
function checkOnActions(args: readonly string[]): { code: number; out: string } {
  process.env.GITHUB_ACTIONS = 'true';
  try {
    return check(args);
  } finally {
    delete process.env.GITHUB_ACTIONS;
  }
}

const HEADS = ['main', 'feature'];

beforeEach(() => {
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
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit, debt left alone');

  const { code, out } = check(['--base', HEADS[0]!]);

  assert.equal(code, 0);
  assert.doesNotMatch(out, /src\/debt\.ts:1/);
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

test("the blocking exit follows the reported finding, not this suite's guess about scoring", () => {
  // The real-fallow cases above prove fallow reports debt; this one proves the plumbing: a finding
  // fallow returns for a touched function is what turns the exit code, and it reaches fallow scoped
  // to this diff. Losing `--diff-file` would widen every PR verdict to the whole repo, and a green
  // run would not notice.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  standInReports({ path: 'src/debt.ts', name: 'score', line: 1, crap: 42 });

  const { code, out } = check(['--base', HEADS[0]!], STANDIN);

  assert.equal(code, 1);
  assert.match(out, /1 touched function\(s\) at or above 30/);
  assert.match(out, /\| `src\/debt\.ts:1` score \| 42\.0 \| 6 \| 0% \|/);
  assert.equal(standInFlags().diffFile, 'coverage/fallow-crap.diff');
});

test('the same finding in report-only scope stays green and asks for no diff', () => {
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  standInReports({ path: 'src/debt.ts', name: 'score', line: 1, crap: 42 });

  const { code, out } = check(['--all'], STANDIN);

  assert.equal(code, 0);
  assert.match(out, /Coverage-based CRAP \(report-only\): 1 function\(s\) at or above 30/);
  assert.equal(standInFlags().diffFile, null);
});

test('a finding does not outvote the missing enumeration it would have been scored from', () => {
  // Both are true at once: there is debt to show and no record of what was measured. Showing the
  // count would let a report that cannot answer its own question read as an answered one.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  fs.rmSync(path.join(repo, 'coverage/lcov.info'));
  standInReports({ path: 'src/debt.ts', name: 'score', line: 1, crap: 42 });

  const { code, out } = check(['--base', HEADS[0]!], STANDIN);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /no usable lcov report lists the files the coverage run measured/);
  assert.doesNotMatch(out, /1 touched function\(s\) at or above 30/);
});

test('an estimated score for a touched function the map predates yields no verdict', () => {
  // The file is in the map, so only this function postdates it: fallow scored it from complexity
  // alone, which is a guess about a function this PR added and no re-run can leave unguessed.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('src/clean.ts', `${TRIVIAL}export const also_trivial = 2;\n`);
  commit('clean edit');
  standInReports({
    path: 'src/clean.ts',
    name: 'also_trivial',
    line: 2,
    crap: 31.6,
    coverage_source: 'estimated',
  });

  const { code, out } = check(['--base', HEADS[0]!], STANDIN);

  assert.equal(code, 1);
  assert.match(out, /no trustworthy verdict/i);
  assert.match(out, /estimated from complexity alone\*\*: `src\/clean\.ts:2` also_trivial/);
});

test('an estimated score in a file coverage never instruments is listed, not blocked on', () => {
  // `scripts/**` is the shape of a normal tooling PR: no re-run would measure it, so blocking would
  // refuse the PR for a file coverage was never asked to instrument. Silent would hide the 31.6.
  writeCoverage({ 'src/debt.ts': {}, 'src/clean.ts': { hits: 4 } });
  write('scripts/tool.ts', 'export const flag = 1;\n');
  commit('add a tooling file');
  standInReports({
    path: 'scripts/tool.ts',
    name: 'flag',
    line: 1,
    crap: 31.6,
    coverage_source: 'estimated',
  });

  const { code, out } = check(['--base', HEADS[0]!], STANDIN);

  assert.equal(code, 0);
  assert.match(out, /no touched function\(s\) at or above 30/);
  assert.match(out, /Not measured, and not blocking.*`scripts\/tool\.ts:1` flag \(CRAP 31\.6\)/s);
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
