import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseAppleTimeProfileSummary } from '../perf-time-profile.ts';

test('reads Xcode 27 tagged-backtrace stacks and skips stack sentinels', () => {
  // xctrace 27 renamed the `time-profile` stack element to `<tagged-backtrace>` and kept the same
  // `id`/`ref` reuse over frames and binaries. These row shapes come from a real 27.1 export; the
  // symbols, binaries, and weights here are synthetic.
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
        <weight ref="weight-1"/>
        <tagged-backtrace id="stack-2" truncated="YES"><frame ref="frame-1"/></tagged-backtrace>
      </row>
      <row>
        <weight ref="weight-1"/>
        <tagged-backtrace id="stack-3">
          <frame id="frame-2" name="warm"><binary ref="binary-1"/></frame>
        </tagged-backtrace>
      </row>
      <row><weight ref="weight-1"/><sentinel/></row>
    </node></trace-query-result>`,
    2,
  );

  // `hot` is sampled as a stack definition, through a `<tagged-backtrace ref>`, and through a
  // truncated stack whose innermost frame is a `<frame ref>`. `warm` reaches its binary only
  // through `<binary ref>`, and the sentinel row carries a weight with no stack at all.
  assert.deepEqual(summary, {
    sampleCount: 4,
    totalSampleWeightMs: 4,
    topFunctions: [
      {
        symbol: 'hot',
        binary: 'App',
        selfSampleMs: 3,
        selfSamplePercent: 75,
      },
      {
        symbol: 'warm',
        binary: 'App',
        selfSampleMs: 1,
        selfSamplePercent: 25,
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

test('aggregates rows exported from multiple trace runs', () => {
  const summary = parseAppleTimeProfileSummary(
    `<trace-query-result>
      <node xpath="/trace-toc/run[1]"><row><weight>1000000</weight><backtrace><frame name="runOne"/></backtrace></row></node>
      <node xpath="/trace-toc/run[2]"><row><weight>2000000</weight><backtrace><frame name="runTwo"/></backtrace></row></node>
    </trace-query-result>`,
  );
  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.topFunctions[0]?.symbol, 'runTwo');
});

test('resolves a frame reference an earlier trace run defined', () => {
  // A real `xctrace record --append-run` export numbers element ids with one counter across its
  // runs, so a row of a later run refs a frame an earlier run defined. Scoping the id index per
  // `<node>` would drop that row's frame instead of attributing it to the earlier symbol.
  const summary = parseAppleTimeProfileSummary(
    `<trace-query-result>
      <node xpath="/trace-toc/run[1]"><row><weight>1000000</weight><tagged-backtrace><frame id="frame-1" name="shared"/></tagged-backtrace></row></node>
      <node xpath="/trace-toc/run[2]"><row><weight>3000000</weight><tagged-backtrace><frame ref="frame-1"/></tagged-backtrace></row></node>
    </trace-query-result>`,
  );
  assert.deepEqual(summary, {
    sampleCount: 2,
    totalSampleWeightMs: 4,
    topFunctions: [
      {
        symbol: 'shared',
        binary: undefined,
        selfSampleMs: 4,
        selfSamplePercent: 100,
      },
    ],
  });
});

test('skips incomplete rows', () => {
  assert.deepEqual(
    parseAppleTimeProfileSummary(
      '<trace-query-result><node><row><weight>1000000</weight></row></node></trace-query-result>',
    ),
    { sampleCount: 0, totalSampleWeightMs: 0, topFunctions: [] },
  );
});
