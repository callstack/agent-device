import assert from 'node:assert/strict';
import { test } from 'vitest';
import { messageWithWarningsOutput, messageWithWarningsText } from './output-common.ts';

test('messageWithWarningsText renders the bare message when there are no warnings', () => {
  assert.equal(messageWithWarningsText({ message: 'Replayed 3 steps' }), 'Replayed 3 steps');
});

test('messageWithWarningsText appends one Warning line per string warning (#2560)', () => {
  const text = messageWithWarningsText({
    message: 'Replayed 3 steps',
    warnings: ['Optional Maestro tapOn skipped at flow.yaml:line 12', 42, null],
  });
  assert.equal(
    text,
    'Replayed 3 steps\nWarning: Optional Maestro tapOn skipped at flow.yaml:line 12',
  );
});

test('messageWithWarningsText renders warnings even without a message', () => {
  assert.equal(
    messageWithWarningsText({ warnings: ['capture degraded'] }),
    'Warning: capture degraded',
  );
});

test('messageWithWarningsText collapses newlines inside a warning', () => {
  assert.equal(
    messageWithWarningsText({ message: 'Replayed 1 step', warnings: ['line one\n  line two'] }),
    'Replayed 1 step\nWarning: line one line two',
  );
});

test('messageWithWarningsText is silent for an empty response', () => {
  assert.equal(messageWithWarningsText({}), null);
});

test('messageWithWarningsOutput carries the same text and the full data', () => {
  const result = { message: 'Replayed 3 steps', warnings: ['one'] };
  assert.deepEqual(messageWithWarningsOutput({ input: {}, result }), {
    data: result,
    text: 'Replayed 3 steps\nWarning: one',
  });
});
