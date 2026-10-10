import { AppError } from '@agent-device/kernel/errors';

/** Most UTF-8 input `fill --text-stdin` accepts, trailing newline included. */
export const FILL_TEXT_STDIN_MAX_BYTES = 64 * 1024;

type StdinSource = AsyncIterable<StdinPiece> & { isTTY?: boolean };

/**
 * Reads the `fill --text-stdin` value. Exactly one trailing `\n` or `\r\n` is removed so a value
 * piped with or without a final newline sends the same text; all other whitespace, including a
 * leading byte order mark, is kept. The value may be a secret: no error raised here includes any
 * of the bytes read.
 */
export async function readFillTextFromStdin(stdin: StdinSource): Promise<string> {
  if (stdin.isTTY) {
    throw new AppError(
      'INVALID_ARGS',
      'fill --text-stdin reads piped input, but stdin is a terminal.',
      {
        reason: 'fill_text_stdin_tty',
        hint: 'Pipe the text in, for example: printf %s "$PASSWORD" | agent-device fill @e3 --text-stdin',
      },
    );
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let heldHighSurrogate = '';
  for await (const chunk of stdin) {
    const next = joinHeldHighSurrogate(heldHighSurrogate, chunk);
    heldHighSurrogate = next.held;
    byteLength += utf8ByteLength(next.piece);
    if (byteLength > FILL_TEXT_STDIN_MAX_BYTES) {
      throw new AppError(
        'INVALID_ARGS',
        `fill --text-stdin accepts at most ${FILL_TEXT_STDIN_MAX_BYTES} bytes of input.`,
        { reason: 'fill_text_stdin_too_large', maxBytes: FILL_TEXT_STDIN_MAX_BYTES },
      );
    }
    chunks.push(encodeWellFormed(next.piece));
  }
  if (heldHighSurrogate) throw invalidUtf8Error();
  const text = stripOneTrailingNewline(decodeUtf8(Buffer.concat(chunks)));
  if (text === '') {
    throw new AppError('INVALID_ARGS', 'fill --text-stdin received no text.', {
      reason: 'fill_text_stdin_empty',
      hint: 'Check that the piped value is set. To clear a field, pass an empty text argument instead: fill @e3 ""',
    });
  }
  return text;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const TRAILING_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

type StdinPiece = Uint8Array | string;

/**
 * A string stream may split a surrogate pair across chunks, so a trailing high surrogate is held
 * back until the next string chunk; a byte chunk cannot complete it.
 */
function joinHeldHighSurrogate(
  held: string,
  chunk: StdinPiece,
): { piece: StdinPiece; held: string } {
  if (typeof chunk !== 'string') {
    if (held) throw invalidUtf8Error();
    return { piece: chunk, held: '' };
  }
  const text = held + chunk;
  return TRAILING_HIGH_SURROGATE.test(text)
    ? { piece: text.slice(0, -1), held: text.slice(-1) }
    : { piece: text, held: '' };
}

/** Sized before encoding, so an oversized string chunk is refused without being copied. */
function utf8ByteLength(piece: StdinPiece): number {
  return typeof piece === 'string' ? Buffer.byteLength(piece, 'utf8') : piece.byteLength;
}

/** `Buffer.from` would turn a lone surrogate into U+FFFD; refuse it like an invalid byte. */
function encodeWellFormed(piece: StdinPiece): Uint8Array {
  if (typeof piece !== 'string') return piece;
  if (LONE_SURROGATE.test(piece)) throw invalidUtf8Error();
  return Buffer.from(piece, 'utf8');
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalidUtf8Error();
  }
}

function invalidUtf8Error(): AppError {
  return new AppError('INVALID_ARGS', 'fill --text-stdin input is not valid UTF-8.', {
    reason: 'fill_text_stdin_invalid_utf8',
  });
}

function stripOneTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}
