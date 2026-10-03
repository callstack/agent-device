import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import fc from 'fast-check';
import { parseFoldInput, parseFoldKeyframesJson } from './device-rotation.ts';

const cases: Array<{ name: string; valid: boolean; keyframesJson: string }> = JSON.parse(
  readFileSync(new URL('../../../contracts/fixtures/fold-keyframes.json', import.meta.url), 'utf8'),
);
test.each(cases)('keyframes: $name', ({ valid, keyframesJson }) => {
  const parse = () => parseFoldKeyframesJson(keyframesJson);
  if (valid) expect(parse()).toEqual(JSON.parse(keyframesJson));
  else expect(parse).toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
});

test('rejects conflicting intent, malformed JSON and nonfinite angles', () => {
  const keyframes = [
    { atMs: 0, angle: 0 },
    { atMs: 10, angle: 180 },
  ];
  expect(() => parseFoldInput({ pose: 'open', keyframes })).toThrow();
  expect(() => parseFoldKeyframesJson('[oops')).toThrow();
  expect(() =>
    parseFoldInput({ keyframes: [{ atMs: 0, angle: Number.NaN }, keyframes[1]] }),
  ).toThrow();
  expect(() =>
    parseFoldInput({ keyframes: Array.from({ length: 65 }, (_, atMs) => ({ atMs, angle: 0 })) }),
  ).toThrow();
});

test('valid timelines round-trip; duplicate timestamps are always rejected', () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          step: fc.integer({ min: 1, max: 900 }),
          angle: fc.integer({ min: 0, max: 1800 }),
        }),
        { minLength: 2, maxLength: 64 },
      ),
      (values) => {
        let time = 0;
        const keyframes = values.map((value, index) => ({
          atMs: index === 0 ? 0 : (time += value.step),
          angle: value.angle / 10,
        }));
        expect(parseFoldKeyframesJson(JSON.stringify(keyframes))).toEqual(keyframes);
        keyframes[1]!.atMs = 0;
        expect(() => parseFoldInput({ keyframes })).toThrow();
      },
    ),
  );
});
