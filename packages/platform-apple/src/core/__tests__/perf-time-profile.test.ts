import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { parseAppleTimeProfileSummary } from '../perf-time-profile.ts';

const XCODE27_FIXTURE_FUNCTION_LIMIT = 25;
const XCODE27_FIXTURE_FUNCTION_COUNT = 15;

test('reads stacks from a real Xcode 27 tagged-backtrace export', () => {
  const xml = readFileSync(
    path.join(import.meta.dirname, 'fixtures', 'xcode27-time-profile.xml'),
    'utf8',
  );
  const summary = parseAppleTimeProfileSummary(xml, XCODE27_FIXTURE_FUNCTION_LIMIT);

  // The captured export carries 22 rows: one stack-sentinel row, two rows that name their stack
  // with a `<tagged-backtrace ref>` to an earlier id, and innermost frames that reuse a
  // `<frame ref>`. Unresolved stacks would drop the count below 21 or leave `<unknown>` names.
  assert.equal(summary.sampleCount, 21);
  assert.equal(summary.totalSampleWeightMs, 21);
  assert.equal(summary.topFunctions.length, XCODE27_FIXTURE_FUNCTION_COUNT);
  assert.ok(!summary.topFunctions.some((entry) => entry.symbol === '<unknown>'));
  // This row names its binary only through `<binary ref>`, so it proves frame-reference
  // resolution reaches the binary too.
  assert.ok(
    summary.topFunctions.some(
      (entry) => entry.symbol === '_xzm_free_pac' && entry.binary === 'libsystem_malloc.dylib',
    ),
    'a referenced binary must resolve to its name',
  );
  assert.deepEqual(summary.topFunctions.slice(0, 2), [
    {
      symbol: 'clonefileat',
      binary: 'libsystem_kernel.dylib',
      selfSampleMs: 5,
      selfSamplePercent: 23.8,
    },
    { symbol: '__open', binary: 'libsystem_kernel.dylib', selfSampleMs: 2, selfSamplePercent: 9.5 },
  ]);
});

test('resolves tagged-backtrace and frame references and skips stack sentinels', () => {
  const summary = parseAppleTimeProfileSummary(
    `<trace-query-result><node>
      <row>
        <weight id="weight-1">1000000</weight>
        <tagged-backtrace id="stack-1">
          <frame id="frame-1" name="hot"><binary id="binary-1" name="App"/></frame>
          <frame name="caller"><binary name="Framework"/></frame>
        </tagged-backtrace>
      </row>
      <row><weight ref="weight-1"/><tagged-backtrace ref="stack-1"/></row>
      <row>
        <weight>1000000</weight>
        <tagged-backtrace><frame ref="frame-1"/><frame name="caller"/></tagged-backtrace>
      </row>
      <row><weight>1000000</weight><sentinel/></row>
    </node></trace-query-result>`,
    1,
  );

  assert.deepEqual(summary, {
    sampleCount: 3,
    totalSampleWeightMs: 3,
    topFunctions: [
      {
        symbol: 'hot',
        binary: 'App',
        selfSampleMs: 3,
        selfSamplePercent: 100,
      },
    ],
  });
});

test('aggregates weighted innermost frames and follows xctrace references', () => {
  const summary = parseAppleTimeProfileSummary(
    `<trace-query-result><node><row>
      <weight id="weight-1">1000000</weight>
      <backtrace id="stack-1">
        <frame id="frame-1" name="hot"><binary id="binary-1" name="App"/></frame>
        <frame name="caller"><binary name="Framework"/></frame>
      </backtrace>
    </row><row>
      <weight ref="weight-1"/><backtrace ref="stack-1"/>
    </row><row>
      <weight>500000</weight>
      <backtrace><frame name="cool"><binary ref="binary-1"/></frame></backtrace>
    </row></node></trace-query-result>`,
    1,
  );

  assert.deepEqual(summary, {
    sampleCount: 3,
    totalSampleWeightMs: 2.5,
    topFunctions: [
      {
        symbol: 'hot',
        binary: 'App',
        selfSampleMs: 2,
        selfSamplePercent: 80,
      },
    ],
  });
});

test('aggregates rows exported from multiple trace runs through one document-wide id index', () => {
  // A real multi-run export numbers element ids with one counter across its runs, so a row in a
  // later run refs a frame an earlier run defined. Scoping the id index per `<node>` would drop
  // that row's frame instead of attributing it to the earlier run's symbol.
  const summary = parseAppleTimeProfileSummary(
    `<trace-query-result>
      <node xpath="/trace-toc/run[1]"><row><weight>1000000</weight><backtrace><frame id="frame-1" name="runOne"/></backtrace></row></node>
      <node xpath="/trace-toc/run[2]">
        <row><weight>2000000</weight><backtrace><frame name="runTwo"/></backtrace></row>
        <row><weight>4000000</weight><backtrace id="stack-9"><frame ref="frame-1"/></backtrace></row>
      </node>
    </trace-query-result>`,
  );
  assert.equal(summary.sampleCount, 3);
  assert.equal(summary.totalSampleWeightMs, 7);
  assert.deepEqual(summary.topFunctions, [
    { symbol: 'runOne', binary: undefined, selfSampleMs: 5, selfSamplePercent: 71.4 },
    { symbol: 'runTwo', binary: undefined, selfSampleMs: 2, selfSamplePercent: 28.6 },
  ]);
});

test('skips incomplete rows', () => {
  assert.deepEqual(
    parseAppleTimeProfileSummary(
      '<trace-query-result><node><row><weight>1000000</weight></row></node></trace-query-result>',
    ),
    { sampleCount: 0, totalSampleWeightMs: 0, topFunctions: [] },
  );
});
