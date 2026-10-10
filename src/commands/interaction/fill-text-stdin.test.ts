import { Readable } from 'node:stream';
import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { FILL_TEXT_STDIN_MAX_BYTES, readFillTextFromStdin } from './fill-text-stdin.ts';

function pipe(...chunks: Array<string | Uint8Array>): Readable {
  return Readable.from(chunks);
}

function terminal(): Readable & { isTTY: boolean } {
  return Object.assign(Readable.from([]), { isTTY: true });
}

async function readError(stdin: Parameters<typeof readFillTextFromStdin>[0]): Promise<AppError> {
  try {
    await readFillTextFromStdin(stdin);
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected readFillTextFromStdin to reject');
}

test.each([
  ['no trailing newline', ['hunter2'], 'hunter2'],
  ['one trailing LF', ['hunter2\n'], 'hunter2'],
  ['one trailing CRLF', ['hunter2\r\n'], 'hunter2'],
  ['only the last of two newlines', ['hunter2\n\n'], 'hunter2\n'],
  ['surrounding spaces and inner newlines', ['  two\nlines  \n'], '  two\nlines  '],
  ['a value split across chunks', ['hun', Buffer.from('ter'), '2\n'], 'hunter2'],
  ['a multi-byte character split across chunks', [Buffer.from([0xc3]), Buffer.from([0xa7])], 'ç'],
  ['a surrogate pair split across string chunks', ['a\uD83D', '\uDE00b'], 'a\u{1F600}b'],
])('reads %s', async (_name, chunks, expected) => {
  expect(await readFillTextFromStdin(pipe(...chunks))).toBe(expected);
});

test('accepts input exactly at the byte limit', async () => {
  const text = 'a'.repeat(FILL_TEXT_STDIN_MAX_BYTES);
  expect(await readFillTextFromStdin(pipe(text))).toBe(text);
});

test('keeps a leading byte order mark', async () => {
  expect(await readFillTextFromStdin(pipe(Buffer.from([0xef, 0xbb, 0xbf, 0x61])))).toBe('\uFEFFa');
});

test.each([
  ['a terminal', () => terminal(), 'fill_text_stdin_tty', undefined],
  ['empty input', () => pipe(), 'fill_text_stdin_empty', undefined],
  ['input that is only a newline', () => pipe('\n'), 'fill_text_stdin_empty', undefined],
  [
    'input over the byte limit',
    () => pipe('s3cret'.repeat(FILL_TEXT_STDIN_MAX_BYTES)),
    'fill_text_stdin_too_large',
    's3cret',
  ],
  [
    'invalid UTF-8 bytes',
    () => pipe(Buffer.from('bad-bytes-'), Buffer.from([0xff])),
    'fill_text_stdin_invalid_utf8',
    'bad-bytes-',
  ],
  [
    'a string chunk with a lone surrogate',
    () => pipe('lone-surrogate-\uD800'),
    'fill_text_stdin_invalid_utf8',
    'lone-surrogate-',
  ],
  [
    'a high surrogate followed by a byte chunk',
    () => pipe('held-surrogate-\uD83D', Buffer.from('x')),
    'fill_text_stdin_invalid_utf8',
    'held-surrogate-',
  ],
  [
    'an oversized string chunk before checking its surrogates',
    () => pipe(`${'s3cret'.repeat(FILL_TEXT_STDIN_MAX_BYTES)}\uDC00`),
    'fill_text_stdin_too_large',
    's3cret',
  ],
])('refuses %s with a typed reason and no echoed input', async (_name, stdin, reason, input) => {
  const error = await readError(stdin());

  expect(error.code).toBe('INVALID_ARGS');
  expect(error.details?.reason).toBe(reason);
  if (input !== undefined) {
    expect(JSON.stringify({ message: error.message, details: error.details })).not.toContain(input);
  }
});
