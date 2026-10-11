// Regression coverage for the two dependency patches under `patches/`, which keep merged v8
// coverage records honest: `@vitest/coverage-v8` must carry a module's wrapper length across the
// merge instead of letting read order decide it, and `ast-v8-to-istanbul` must not publish a
// branch counter no execution could produce. Both defects made whole files unscored (#3425).
//
// The async branch cases run on records captured from a real inspector session and pinned in
// `patches.fixture.json`, because V8 serves a repeatedly-evaluated script from its compile cache
// as function-level coverage, which would make a live-capture assertion flaky. Each pinned record
// carries the hand-instrumented entered/taken counts that established its expected counters.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseAstAsync } from 'vitest/node';
import { test } from 'node:test';
import {
  UNKNOWN_WRAPPER_LENGTH,
  unmappableCoverageRecord,
  WrapperLengths,
} from '@vitest/coverage-v8/dist/wrapper-lengths.js';
import { sanitizeIstanbulCoverage, type IstanbulCoverageMap } from './model.ts';

const PROVIDER_ENTRY = import.meta.resolve('@vitest/coverage-v8');

/** Resolves a dependency of the coverage provider rather than of this repository. */
const providerRequire = createRequire(PROVIDER_ENTRY);

/**
 * Loads one such dependency, so the test uses exactly the copy the patched provider loads.
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

// ---- Defect A: the wrapper length must survive the merge -------------------

// Six workers recorded `runner-cache-retention.ts` on the run that left it unscored: five had
// finished evaluating it and measured its wrapper, the sixth's dynamic import was still in
// flight and measured nothing. The provider merged the module with whichever of the two the last
// file it read happened to carry, so the same suite scored or unscored the file at random.
const MEASURED_WRAPPER = 209;
const MODULE_URL = '/virtual/module.ts';

test('one unmeasured wrapper cannot replace the length the other workers measured', () => {
  for (const unmeasuredFirst of [false, true]) {
    const lengths = new WrapperLengths();
    const readOrder = unmeasuredFirst
      ? [UNKNOWN_WRAPPER_LENGTH, ...Array.from({ length: 5 }, () => MEASURED_WRAPPER)]
      : [...Array.from({ length: 5 }, () => MEASURED_WRAPPER), UNKNOWN_WRAPPER_LENGTH];
    for (const startOffset of readOrder) lengths.add(MODULE_URL, startOffset);
    assert.equal(
      lengths.resolve(MODULE_URL),
      MEASURED_WRAPPER,
      `read order must not decide the wrapper length (unmeasured read ${unmeasuredFirst ? 'first' : 'last'})`,
    );
  }
});

test('a wrapper two workers measured differently is unresolved, never guessed', () => {
  for (const readOrder of [
    [MEASURED_WRAPPER, 0],
    [0, MEASURED_WRAPPER],
  ]) {
    const lengths = new WrapperLengths();
    for (const startOffset of readOrder) lengths.add(MODULE_URL, startOffset);
    assert.equal(lengths.resolve(MODULE_URL), UNKNOWN_WRAPPER_LENGTH);
  }
});

test('a module whose wrapper nobody measured is invalid rather than zero-length', () => {
  const lengths = new WrapperLengths();
  lengths.add(MODULE_URL, UNKNOWN_WRAPPER_LENGTH);
  assert.equal(lengths.resolve(MODULE_URL), UNKNOWN_WRAPPER_LENGTH);
  // A module no worker reported at all is a different case: nothing was ever claimed about it.
  assert.equal(lengths.resolve('/virtual/other.ts'), 0);
});

test('a provider that measures no wrappers at all keeps unwrapped scripts at zero', () => {
  // Browser mode evaluates modules in the page without the SSR wrapper, so its scripts carry no
  // measurement. Reading that as "unmeasured" would invalidate every browser-mode file.
  const lengths = new WrapperLengths();
  lengths.add(MODULE_URL, undefined);
  assert.equal(lengths.resolve(MODULE_URL), 0);
});

test('wrapper measurements do not leak into the next report window', () => {
  const lengths = new WrapperLengths();
  lengths.add(MODULE_URL, MEASURED_WRAPPER);
  assert.equal(lengths.resolve(MODULE_URL), MEASURED_WRAPPER);
  lengths.clear();
  // Each project/environment group converts the files it just read with the measurements its own
  // workers made; a length from another group is not evidence for this one's scripts.
  assert.equal(lengths.resolve(MODULE_URL), 0);
});

test('an unmeasurable module yields a record the CRAP sanitizer drops', async () => {
  const record = unmappableCoverageRecord(`file://${MODULE_URL}`, undefined)[
    MODULE_URL
  ] as IstanbulRecord;
  assert.equal(record.s[0], null);

  // The marker has to survive merging with a measured record for the same file: a counter that
  // added away would hand consumers a plausible record for offsets nobody measured. Merging
  // re-keys the statements, so the assertion is on the set of counters rather than an index.
  type CoverageMap = {
    merge: (data: unknown) => void;
    toJSON: () => IstanbulCoverageMap;
  };
  const { createCoverageMap } = providerRequire('istanbul-lib-coverage') as {
    createCoverageMap: () => CoverageMap;
  };
  for (const measuredFirst of [false, true]) {
    const map = createCoverageMap();
    const measured = {
      ...record,
      s: { 0: 7 },
      statementMap: { 0: { start: { line: 3, column: 0 }, end: { line: 3, column: 9 } } },
    };
    const marker = { ...record, statementMap: { 0: record.statementMap[0] } };
    if (measuredFirst) {
      map.merge({ [MODULE_URL]: measured });
      map.merge({ [MODULE_URL]: marker });
    } else {
      map.merge({ [MODULE_URL]: marker });
      map.merge({ [MODULE_URL]: measured });
    }
    const merged = map.toJSON()[MODULE_URL] as IstanbulRecord;
    assert.ok(
      Object.values(merged.s).includes(null),
      `a measured record must not repair an unmeasurable file (measured merged ${measuredFirst ? 'first' : 'last'})`,
    );
    const { map: kept, dropped } = sanitizeIstanbulCoverage(map.toJSON() as IstanbulCoverageMap);
    assert.deepEqual(kept, {});
    assert.deepEqual(dropped, [MODULE_URL]);
  }
});

// ---- Defect B: async branch counts ---------------------------------------

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
