import { describe, expect, test } from 'vitest';
import { suggestClosestKey } from './key-suggestions.ts';

// The rule set is the CLI parser's nearest-name rule (command and flag
// suggestions): prefix matches win, only minimum-distance ties are kept,
// short tokens earn nothing, and the answer is deterministic.
describe('suggestClosestKey', () => {
  const KEYS = ['path', 'fullscreen', 'cropOn', 'scale'];

  test('a one-edit typo names the single closest key', () => {
    expect(suggestClosestKey('fullscren', KEYS)).toBe('fullscreen');
    expect(suggestClosestKey('scal', KEYS)).toBe('scale');
  });

  test('a prefix of a key resolves to that key by length difference', () => {
    expect(suggestClosestKey('full', KEYS)).toBe('fullscreen');
  });

  test('ties are answered with the whole set, in order', () => {
    expect(suggestClosestKey('pathh', ['path', 'patch', 'pause'])).toBe('one of: patch, path');
  });

  test('short tokens earn no suggestion', () => {
    expect(suggestClosestKey('pa', KEYS)).toBeUndefined();
  });

  test('a distant token earns no suggestion', () => {
    expect(suggestClosestKey('output', KEYS)).toBeUndefined();
  });

  test('an exact match is the key itself', () => {
    expect(suggestClosestKey('path', KEYS)).toBe('path');
  });
});
