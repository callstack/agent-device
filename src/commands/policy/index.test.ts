import { describe, expect, test } from 'vitest';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  actCliReader,
  actCommandMetadata,
  suggestCliReader,
  suggestCommandMetadata,
} from './index.ts';
import { createPolicyProvider } from './policy-provider.ts';

describe('policy command interface', () => {
  test('owns suggest and act public metadata', () => {
    expect(suggestCommandMetadata.name).toBe('suggest');
    expect(actCommandMetadata.name).toBe('act');
  });

  test('reads a goal positional and the policy flag', () => {
    expect(suggestCliReader(['sign in'], { policy: 'jev' } as CliFlags)).toMatchObject({
      goal: 'sign in',
      policy: 'jev',
    });
  });

  test('reads the loop budget, confidence floor, and input map', () => {
    expect(
      actCliReader(['sign in'], {
        batchMaxSteps: 8,
        minConfidence: 0.6,
        policyInput: ['phone=5555550100'],
      } as unknown as CliFlags),
    ).toMatchObject({
      goal: 'sign in',
      maxSteps: 8,
      minConfidence: 0.6,
      inputs: ['phone=5555550100'],
    });
  });

  test('refuses an empty goal', () => {
    for (const read of [suggestCliReader, actCliReader]) {
      expect(() => read(['   '], {} as CliFlags)).toThrow(
        expect.objectContaining({
          code: 'INVALID_ARGS',
          message: expect.stringContaining('needs a goal'),
        }),
      );
    }
  });
});

describe('policy provider resolution', () => {
  test('refuses to run without a key, naming the environment entry and the fallback', () => {
    expect(() => createPolicyProvider('jev', {})).toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('TYPESAFE_API_KEY is not set'),
      }),
    );
  });

  test('refuses an unknown provider name', () => {
    expect(() => createPolicyProvider('oracle', { TYPESAFE_API_KEY: 'k' })).toThrow(
      expect.objectContaining({ message: expect.stringContaining('Unknown policy provider') }),
    );
  });

  test('builds the jev provider when the key is present', () => {
    expect(createPolicyProvider('jev', { TYPESAFE_API_KEY: 'k' }).name).toBe('jev');
  });
});
