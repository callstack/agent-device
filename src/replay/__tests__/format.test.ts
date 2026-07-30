import { describe, expect, test } from 'vitest';
import { resolveReplayFormat } from '../format.ts';

describe('resolveReplayFormat', () => {
  test('keeps .ad on the native engine even when Maestro is requested', () => {
    expect(resolveReplayFormat('/flows/login.ad', 'maestro')).toBe('ad');
  });

  test.each(['/flows/login.yaml', '/flows/login.yml'])(
    'routes %s to Maestro only when explicitly requested',
    (sourcePath) => {
      expect(resolveReplayFormat(sourcePath, 'maestro')).toBe('maestro');
      expect(resolveReplayFormat(sourcePath, undefined)).toBe('ad');
    },
  );
});
