import { Transform } from 'node:stream';

export type ByteLimitStream = Transform & {
  readonly bytesSeen: number;
};

export function createByteLimitStream(options: {
  maxBytes: number;
  createLimitError: () => Error;
}): ByteLimitStream {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }

  let bytesSeen = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const nextBytesSeen = bytesSeen + chunk.byteLength;
      if (!Number.isSafeInteger(nextBytesSeen) || nextBytesSeen > options.maxBytes) {
        callback(options.createLimitError());
        return;
      }
      bytesSeen = nextBytesSeen;
      callback(null, chunk);
    },
  }) as ByteLimitStream;
  Object.defineProperty(stream, 'bytesSeen', {
    enumerable: true,
    get: () => bytesSeen,
  });
  return stream;
}
