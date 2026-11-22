import { describe, expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { claimKeyOf, readableClaimsOfValue } from './validate.ts';

// The readable claims of a value that failed before its claims were validated. The registry
// reserves these, so a leaf the id cannot narrow must refuse the read rather than widen the claim.

const leafContribution = {
  kind: 'platform',
  family: 'apple',
  appleOs: 'macos',
  setup: () => undefined,
};

function appError(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the readable claim read to refuse');
}

describe('readableClaimsOfValue reads one platform leaf spelling', () => {
  test.each([
    ['the manifest spelling', { apiVersion: 3, platform: 'apple', appleOs: 'macos' }],
    [
      'the contribution spelling',
      {
        apiVersion: 3,
        contributes: [leafContribution],
      },
    ],
  ] as const)('%s', (_name, value) => {
    expect(readableClaimsOfValue(value).map(claimKeyOf)).toEqual(['platform:apple:macos']);
  });

  test.each([
    ['the manifest spelling', { apiVersion: 3, platform: 'apple', appleOs: 'ios' }],
    ['a malformed leaf', { apiVersion: 3, platform: 'apple', appleOs: 'MacOS' }],
    ['a leaf on another family', { apiVersion: 3, platform: 'web', appleOs: 'macos' }],
    [
      'the contribution spelling',
      {
        apiVersion: 3,
        contributes: [{ ...leafContribution, appleOs: 'ios' }],
      },
    ],
    [
      'a malformed contribution leaf',
      {
        apiVersion: 3,
        contributes: [{ ...leafContribution, appleOs: true }],
      },
    ],
    [
      'a leaf on another family in a contribution',
      {
        apiVersion: 3,
        contributes: [{ ...leafContribution, family: 'web', appleOs: 'macos' }],
      },
    ],
  ] as const)('refers to %s as invalid_plugin rather than widening it', (_name, value) => {
    const error = appError(() => readableClaimsOfValue(value));
    expect(error.code).toBe('INVALID_ARGS');
    expect(error.details?.reason).toBe('invalid_plugin');
  });

  test('reads a whole-family platform claim and a provider claim unchanged', () => {
    expect(
      readableClaimsOfValue({
        apiVersion: 3,
        platform: 'apple',
        contributes: [{ kind: 'provider', provider: 'example' }],
      }).map(claimKeyOf),
    ).toEqual(['provider:example', 'platform:apple']);
  });
});
