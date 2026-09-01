import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseAppleTimeProfileSummary } from '../perf-time-profile.ts';

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

test('skips incomplete rows', () => {
  assert.deepEqual(
    parseAppleTimeProfileSummary(
      '<trace-query-result><node><row><weight>1000000</weight></row></node></trace-query-result>',
    ),
    { sampleCount: 0, totalSampleWeightMs: 0, topFunctions: [] },
  );
});
