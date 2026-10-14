// Regression coverage for the dependency patch under `patches/`, which keeps merged v8 coverage
// records honest: `ast-v8-to-istanbul` must not publish a branch counter no execution could
// produce. The defect made whole files unscored (#3425).
//
// The cases run on records captured from a real inspector session and pinned in
// `patches.fixture.json`, because V8 serves a repeatedly-evaluated script from its compile cache as
// function-level coverage, which would make a live-capture assertion flaky. Each pinned record
// carries the hand-instrumented entered/taken counts that established its expected counters.
//
// #3448's other patch, on `@vitest/coverage-v8`, is gone: Vitest 5 keeps a module's script wrapper
// offset through the merge of the workers' coverage files instead of letting read order or a pending
// dynamic import decide it (vitest-dev/vitest#10506, #10643), so no patched module is left to
// unit-test. Its symptom was a whole file scored from offsets shifted off its source by the wrapper,
// and a shifted record carries only plausible counts, so nothing here can see it: the guard for that
// class is upstream's merge, and `check:coverage-crap` still blocks a touched file missing from the
// map or holding a count no execution can produce.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseAstAsync } from 'vitest/node';
import { test } from 'node:test';
import { sanitizeIstanbulCoverage, type IstanbulCoverageMap } from './model.ts';

const PROVIDER_ENTRY = import.meta.resolve('@vitest/coverage-v8');

/** Resolves a dependency of the coverage provider rather than of this repository. */
const providerRequire = createRequire(PROVIDER_ENTRY);

/**
 * Loads one such dependency, so the test uses exactly the copy the provider loads.
 * Named exports stay named, and a CommonJS package keeps its `default`.
 */
async function loadProviderDependency<T>(name: string): Promise<T> {
  return (await import(pathToFileURL(providerRequire.resolve(name)).href)) as T;
}

const loadConverter = async () =>
  (await loadProviderDependency<{ default: Converter }>('ast-v8-to-istanbul')).default;

type Converter = (input: unknown) => Promise<IstanbulCoverageMap>;

type IstanbulRecord = {
  path: string;
  statementMap: Record<string, unknown>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
  branchMap: Record<string, { type: string; line: number }>;
};

type V8Function = {
  functionName: string;
  isBlockCoverage: boolean;
  ranges: { startOffset: number; endOffset: number; count: number }[];
};

/** One pinned capture: the module, the raw V8 record, and what really executed. */
type Capture = {
  wrapperLength: number;
  url: string;
  code: string;
  functions: V8Function[];
  branches: Record<string, { line: number; entered: number; taken: number; counters: number[] }>;
};

const captures = JSON.parse(
  fs.readFileSync(new URL('./patches.fixture.json', import.meta.url), 'utf8'),
) as Record<string, Capture>;

const TARGET = '/virtual/target.mjs';

async function convertRecord(convert: Converter, capture: Capture): Promise<IstanbulRecord> {
  const converted = await convert({
    code: capture.code,
    ast: await parseAstAsync(capture.code),
    coverage: { functions: capture.functions, url: capture.url },
    wrapperLength: capture.wrapperLength,
  });
  return converted[TARGET] as IstanbulRecord;
}

/** The counters the converter publishes for the `if` on `line`. */
function ifCounters(record: IstanbulRecord, line: number): number[] {
  const id = Object.keys(record.b).find(
    (key) => record.branchMap[key].type === 'if' && record.branchMap[key].line === line,
  );
  assert.ok(id, `the converter recorded no if branch on line ${line}`);
  return record.b[id].map(Number);
}

// `async-fallback-operand` is the reported shape: `params.release ?? await probe(...)` feeding an
// `if` with no `else`. Six callers short-circuit the `??` and take the branch, two await and do
// not. The converter invents the missing path's counter by subtracting one block-containment
// lookup from another, and inside an async function those two lookups land on counts of different
// paths, so it published `[6,-6]`. The record's block tree is V8's own:

test('an async branch with an awaited operand drops the path it cannot count', async () => {
  const convert = await loadConverter();
  const capture = captures['async-fallback-operand'];
  const branch = capture.branches.i1;
  assert.deepEqual([branch.entered, branch.taken], [8, 6]);
  const record = await convertRecord(convert, capture);
  // The taken path is provable and stays. The entry count is not recoverable from a record whose
  // continuation block is counted for the awaited path only, so the implicit else is left out
  // rather than published as `[6,-6]` — the same one-location branch the reference
  // v8-to-istanbul converter produces for this input.
  assert.deepEqual(ifCounters(record, branch.line), [6]);
});

test('a branch whose awaited continuation out-counts it publishes no impossible count', async () => {
  const convert = await loadConverter();
  const capture = captures['early-return-then-fallback'];
  const record = await convertRecord(convert, capture);
  assert.deepEqual([capture.branches.i1.entered, capture.branches.i1.taken], [8, 3]);
  assert.deepEqual([capture.branches.i2.entered, capture.branches.i2.taken], [5, 2]);
  // The branch ahead of the await is counted correctly and must not move; the one behind it was
  // `[2,-2]` before the patch.
  assert.deepEqual(ifCounters(record, capture.branches.i1.line), [3, 5]);
  assert.deepEqual(ifCounters(record, capture.branches.i2.line), [2]);
});

test('sync and non-awaited branches keep counting their implicit else', async () => {
  const convert = await loadConverter();
  for (const name of ['sync-fallback-operand', 'plain-async']) {
    const capture = captures[name];
    const branch = capture.branches.i1;
    assert.deepEqual(
      ifCounters(await convertRecord(convert, capture), branch.line),
      [6, 2],
      `branch counters moved for a record the defect never touched (${name})`,
    );
  }
});

test('the patch changes nothing about a record it does not apply to', async () => {
  const convert = await loadConverter();
  for (const capture of Object.values(captures)) {
    const record = await convertRecord(convert, capture);
    const { map, dropped } = sanitizeIstanbulCoverage({ [TARGET]: record });
    assert.deepEqual(dropped, [], 'the converter published an impossible counter');
    assert.deepEqual(Object.keys(map), [TARGET]);
    for (const branch of Object.values(capture.branches)) {
      assert.deepEqual(
        ifCounters(record, branch.line),
        branch.counters,
        `counters drifted from the pinned expectation (line ${branch.line})`,
      );
    }
  }
});
