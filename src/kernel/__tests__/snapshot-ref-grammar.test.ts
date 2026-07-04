import { expect, test } from 'vitest';
import { normalizeRef, splitRefGenerationSuffix } from '../snapshot.ts';

// #1076 versioned refs: `~s<generation>` is accepted INPUT on every ref parse
// site; node lookup strips it, and callers that care read the generation.

test('splitRefGenerationSuffix passes plain refs through without a generation', () => {
  expect(splitRefGenerationSuffix('@e12')).toEqual({ base: '@e12' });
  expect(splitRefGenerationSuffix('e12')).toEqual({ base: 'e12' });
  expect(splitRefGenerationSuffix('  @e12  ')).toEqual({ base: '@e12' });
});

test('splitRefGenerationSuffix splits well-formed pinned refs', () => {
  expect(splitRefGenerationSuffix('@e12~s3')).toEqual({ base: '@e12', generation: 3 });
  expect(splitRefGenerationSuffix('e12~s3')).toEqual({ base: 'e12', generation: 3 });
  expect(splitRefGenerationSuffix('@e7~s0')).toEqual({ base: '@e7', generation: 0 });
  expect(splitRefGenerationSuffix('@e7~s142')).toEqual({ base: '@e7', generation: 142 });
});

test('splitRefGenerationSuffix rejects malformed suffixes', () => {
  expect(splitRefGenerationSuffix('@e12~')).toBeNull();
  expect(splitRefGenerationSuffix('@e12~s')).toBeNull();
  expect(splitRefGenerationSuffix('@e12~3')).toBeNull();
  expect(splitRefGenerationSuffix('@e12~x3')).toBeNull();
  expect(splitRefGenerationSuffix('@e12~s3x')).toBeNull();
  expect(splitRefGenerationSuffix('@e12~s-3')).toBeNull();
  expect(splitRefGenerationSuffix('@e12~s3~s4')).toBeNull();
  // A leading tilde has no ref to pin.
  expect(splitRefGenerationSuffix('~s3')).toBeNull();
});

test('normalizeRef keeps legacy behavior for plain refs', () => {
  expect(normalizeRef('@e12')).toBe('e12');
  expect(normalizeRef('e12')).toBe('e12');
  expect(normalizeRef('@')).toBeNull();
  expect(normalizeRef('12')).toBeNull();
});

test('normalizeRef strips a well-formed generation suffix for node lookup', () => {
  expect(normalizeRef('@e12~s3')).toBe('e12');
  expect(normalizeRef('e12~s3')).toBe('e12');
});

test('normalizeRef rejects malformed generation suffixes', () => {
  expect(normalizeRef('@e12~s')).toBeNull();
  expect(normalizeRef('@e12~x3')).toBeNull();
  expect(normalizeRef('@e12~')).toBeNull();
});
