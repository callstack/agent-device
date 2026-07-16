import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createOrderedProviderTranscript, createProviderTranscript } from './transcript.ts';

test('provider transcript matches expected calls without requiring incidental order', () => {
  const transcript = createProviderTranscript([
    { command: 'ios.runner.snapshot', result: { ok: 'snapshot' } },
    { command: 'ios.runner.tap', request: { command: 'tap', x: 10, y: 20 }, result: { ok: 'tap' } },
  ]);

  assert.deepEqual(transcript.next('ios.runner.tap', { command: 'tap', x: 10, y: 20 }), {
    ok: 'tap',
  });
  assert.deepEqual(transcript.next('ios.runner.snapshot'), { ok: 'snapshot' });
  transcript.assertComplete();
});

test('repeat entries serve every matching call and never count as unconsumed', () => {
  const transcript = createProviderTranscript([
    { command: 'ios.runner.snapshot', repeat: true, result: { ok: 'snapshot' } },
    { command: 'ios.runner.tap', result: { ok: 'tap' } },
  ]);

  assert.deepEqual(transcript.next('ios.runner.snapshot'), { ok: 'snapshot' });
  assert.deepEqual(transcript.next('ios.runner.snapshot'), { ok: 'snapshot' });
  assert.deepEqual(transcript.next('ios.runner.tap'), { ok: 'tap' });

  // The repeat entry stays pending forever; only the one-shot tap had to land.
  transcript.assertComplete();
  assert.equal(transcript.calls.length, 3);
});

test('one-shot entries still outrank a repeat entry and remain required', () => {
  const transcript = createProviderTranscript([
    { command: 'ios.runner.snapshot', result: { ok: 'first' } },
    { command: 'ios.runner.snapshot', repeat: true, result: { ok: 'rest' } },
  ]);

  assert.deepEqual(transcript.next('ios.runner.snapshot'), { ok: 'first' });
  assert.deepEqual(transcript.next('ios.runner.snapshot'), { ok: 'rest' });
  assert.deepEqual(transcript.next('ios.runner.snapshot'), { ok: 'rest' });
  transcript.assertComplete();
});

test('a repeat declared before a matching one-shot does not shadow it', () => {
  // Outranking is a rule, not an accident of declaration order: taking the
  // first match would serve the repeat forever and strand the one-shot.
  const transcript = createProviderTranscript([
    { command: 'ios.runner.snapshot', repeat: true, result: { ok: 'rest' } },
    { command: 'ios.runner.snapshot', result: { ok: 'first' } },
  ]);

  assert.deepEqual(transcript.next('ios.runner.snapshot'), { ok: 'first' });
  assert.deepEqual(transcript.next('ios.runner.snapshot'), { ok: 'rest' });
  assert.deepEqual(transcript.next('ios.runner.snapshot'), { ok: 'rest' });
  transcript.assertComplete();
});

test('ordered transcripts reject repeat entries outright', () => {
  // Ordered lookup only ever reads entry 0, so a repeat there never advances
  // and makes every later entry unreachable. Refuse the combination instead of
  // failing later as a confusing command mismatch.
  assert.throws(
    () =>
      createOrderedProviderTranscript([
        { command: 'ios.runner.snapshot', repeat: true, result: { ok: 'snapshot' } },
        { command: 'ios.runner.tap', result: { ok: 'tap' } },
      ]),
    /repeat/i,
  );
});

test('unconsumed one-shot entries still fail assertComplete alongside a repeat entry', () => {
  const transcript = createProviderTranscript([
    { command: 'ios.runner.snapshot', repeat: true, result: { ok: 'snapshot' } },
    { command: 'ios.runner.tap', result: { ok: 'tap' } },
  ]);

  transcript.next('ios.runner.snapshot');
  assert.throws(() => transcript.assertComplete(), /Unconsumed provider transcript entries.*tap/s);
});

test('a result factory is invoked per call, so repeated calls can return fresh results', () => {
  let capture = 0;
  const transcript = createProviderTranscript([
    {
      command: 'ios.runner.snapshot',
      repeat: true,
      result: () => {
        capture += 1;
        return { label: `Loading ${capture}` };
      },
    },
  ]);

  assert.deepEqual(transcript.next('ios.runner.snapshot'), { label: 'Loading 1' });
  assert.deepEqual(transcript.next('ios.runner.snapshot'), { label: 'Loading 2' });
  // The recorded call carries the resolved result, not the factory.
  assert.deepEqual(
    transcript.calls.map((call) => call.result),
    [{ label: 'Loading 1' }, { label: 'Loading 2' }],
  );
});

test('ordered provider transcript remains available when ordering is the contract', () => {
  const transcript = createOrderedProviderTranscript([
    { command: 'ios.runner.snapshot', result: { ok: 'snapshot' } },
    { command: 'ios.runner.tap', result: { ok: 'tap' } },
  ]);

  assert.throws(
    () => transcript.next('ios.runner.tap'),
    /Provider command mismatch|Unexpected provider call/,
  );
});
