import { createRequire } from 'node:module';
import type { Rolldown } from 'vite';

export function jpegDecoderOnly(): Rolldown.Plugin {
  const id = '\0agent-device:jpeg-decoder';
  const require = createRequire(
    new URL('../../packages/capture-kit/package.json', import.meta.url),
  );
  return {
    name: 'jpeg-decoder-only',
    resolveId(source) {
      if (source === 'jpeg-js') return id;
    },
    load(source) {
      if (source === id) {
        return `export { default as decode } from ${JSON.stringify(require.resolve('jpeg-js/lib/decoder.js'))};`;
      }
    },
  };
}
