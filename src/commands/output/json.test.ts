import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { NormalizedError } from '@agent-device/kernel/errors';
import { printJson } from './json.ts';

afterEach(() => vi.restoreAllMocks());

function captureStdout(): string[] {
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output.push(String(chunk));
    return true;
  });
  return output;
}

test('printJson redacts a secret-like value an INVALID_ARGS error echoes', () => {
  const output = captureStdout();
  const error: Partial<NormalizedError> = {
    code: 'INVALID_ARGS',
    message:
      'fill accepts at most 2 positional argument(s), received 3: @e1 Sup3rSecretPass!2026 extra',
    hint: 'Fix the command arguments.',
  };

  printJson({ success: false, error: error as NormalizedError });

  const written = output.join('');
  assert.match(written, /<redacted len=20>/);
  assert.equal(written.includes('Sup3rSecretPass!2026'), false);
  assert.match(written, /"hint": "Fix the command arguments\."/);
  assert.equal(JSON.parse(written).error.message.includes('<redacted len=20>'), true);
});

test('printJson keeps ordinary INVALID_ARGS messages and other codes as typed', () => {
  const output = captureStdout();

  printJson({
    success: false,
    error: {
      code: 'INVALID_ARGS',
      message: 'press accepts at most 2 positional argument(s), received 3: @e1 hello world',
    } as NormalizedError,
  });
  const ordinary = output.join('');
  assert.match(ordinary, /received 3: @e1 hello world/);
  assert.equal(ordinary.includes('<redacted'), false);

  output.length = 0;
  printJson({
    success: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'the daemon rejected credential Sup3rSecretPass!2026',
    } as NormalizedError,
  });
  assert.match(output.join(''), /Sup3rSecretPass!2026/);
});
