import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SAMPLE_PRODUCERS } from './help-conformance-sample-producers.ts';

// Every quiz case in scripts/help-conformance-cases.mjs quotes "captured"
// agent-device output. These tests rebuild each quoted sample through the real
// production renderer, so a rendering or message change fails HERE instead of
// leaving the benchmark grading models against output the CLI no longer
// prints — the drift class that made hand-transcribed samples untrustworthy.
//
// The producers live in ./help-conformance-sample-producers.ts as data so the
// coverage gate can assert every exported sample HAS one
// (help-conformance-error-recovery-coverage.test.ts).

for (const { name, producer, sample, render } of SAMPLE_PRODUCERS) {
  test(`${name} matches ${producer}`, async () => {
    assert.equal(await render(), sample.output);
  });
}
