import { describe, expect, it } from 'vitest';
import { localRuntimeOwner, providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { createUnavailableRuntimeFactsForTest } from './runtime-operation-facts.ts';

describe('createUnavailableRuntimeFactsForTest', () => {
  it('derives the complete operation surface as unavailable', () => {
    const facts = createUnavailableRuntimeFactsForTest(IOS_SIMULATOR, localRuntimeOwner('apple'));

    expect(Object.values(facts.operations).every((fact) => !fact.available)).toBe(true);
    expect(facts.operations).toMatchObject({
      captureScreenshot: { available: false, reason: 'owner-capability-missing' },
      typeText: { available: false, reason: 'owner-capability-missing' },
      finalizeApplicationClose: { available: false, reason: 'owner-capability-missing' },
    });
    expect(facts.device.providerMode).toBe('local');
  });

  it('preserves an exact provider gap across every derived cell', () => {
    const unsupportedProvider = {
      available: false,
      reason: 'unsupported-provider-mode',
    } as const;
    const facts = createUnavailableRuntimeFactsForTest(
      IOS_SIMULATOR,
      providerRuntimeOwner('test', 'fixtures'),
      unsupportedProvider,
    );

    expect(
      Object.values(facts.operations).every(
        (fact) => !fact.available && fact.reason === 'unsupported-provider-mode',
      ),
    ).toBe(true);
    expect(facts.device.providerMode).toBe('provider-runtime');
  });
});
