import { describe, expect, test } from 'vitest';
import { runPolicyAct, suggestPolicyAction, type PolicyClientCalls } from './client-policy.ts';

/** A device surface that fails the test if the commands reach it. */
function forbiddenDevice(): PolicyClientCalls & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    snapshot: async () => {
      touched.push('snapshot');
      return { nodes: [] };
    },
    press: async () => {
      touched.push('press');
    },
    fill: async () => {
      touched.push('fill');
    },
  };
}

describe('policy commands without a key', () => {
  test('suggest refuses before reading the screen', async () => {
    const device = forbiddenDevice();
    await expect(suggestPolicyAction(device, { goal: 'sign in' }, {})).rejects.toThrow(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: expect.stringContaining('TYPESAFE_API_KEY is not set'),
      }),
    );
    expect(device.touched).toEqual([]);
  });

  test('act refuses before reading the screen', async () => {
    const device = forbiddenDevice();
    await expect(runPolicyAct(device, { goal: 'sign in' }, {})).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_ARGS' }),
    );
    expect(device.touched).toEqual([]);
  });

  test('the refusal names both the way to enable it and the way without it', async () => {
    const device = forbiddenDevice();
    await expect(suggestPolicyAction(device, { goal: 'sign in' }, {})).rejects.toMatchObject({
      details: {
        reason: 'policy-provider-unconfigured',
        hint: expect.stringContaining('Export TYPESAFE_API_KEY'),
      },
    });
    await expect(suggestPolicyAction(device, { goal: 'sign in' }, {})).rejects.toMatchObject({
      details: { hint: expect.stringContaining('fall back to agent-driven policy') },
    });
  });

  test('an empty key is treated as no key', async () => {
    const device = forbiddenDevice();
    await expect(
      suggestPolicyAction(device, { goal: 'sign in' }, { TYPESAFE_API_KEY: '   ' }),
    ).rejects.toThrow(expect.objectContaining({ code: 'INVALID_ARGS' }));
    expect(device.touched).toEqual([]);
  });
});

describe('the rest of the command surface without a key', () => {
  test('every other command keeps its descriptor untouched by the policy feature', async () => {
    const { commandDescriptors } = await import('@agent-device/command-registry/registry');
    const policyNames = new Set(['suggest', 'act']);
    const others = commandDescriptors.filter((descriptor) => !policyNames.has(descriptor.name));

    // The feature adds two descriptors and changes none: anything that reads the registry at
    // startup behaves identically whether or not a key is present, because no existing command
    // gained a policy field.
    for (const descriptor of others) {
      expect(JSON.stringify(descriptor)).not.toContain('policy');
    }
    expect(
      commandDescriptors.filter((descriptor) => policyNames.has(descriptor.name)),
    ).toHaveLength(2);
  });
});
