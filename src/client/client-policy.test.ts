import { describe, expect, test } from 'vitest';
import {
  createPolicyDevicePort,
  runPolicyAct,
  suggestPolicyAction,
  type PolicyClientCalls,
} from './client-policy.ts';

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

describe("the loop's device port", () => {
  /** Records what the port sent to the client, with the snapshot generations it was handed. */
  function recordingCalls(generations: readonly (number | undefined)[]): PolicyClientCalls & {
    sent: string[];
  } {
    const sent: string[] = [];
    let index = 0;
    return {
      sent,
      snapshot: async () => {
        const refsGeneration = generations[Math.min(index++, generations.length - 1)];
        sent.push(`snapshot~${refsGeneration ?? 'none'}`);
        return { nodes: [], ...(refsGeneration === undefined ? {} : { refsGeneration }) };
      },
      press: async ({ ref }) => {
        sent.push(`press ${ref}`);
      },
      fill: async ({ ref, text }) => {
        sent.push(`fill ${ref} ${text}`);
      },
    };
  }

  test('pins a mutation to the generation of the snapshot that issued its ref', async () => {
    const calls = recordingCalls([7]);
    const port = createPolicyDevicePort(calls, {});
    await port.snapshot();
    await port.press('@e12');
    await port.fill('@e12', 'hello');
    expect(calls.sent).toEqual(['snapshot~7', 'press @e12~s7', 'fill @e12~s7 hello']);
  });

  test('re-pins after a later snapshot reissues refs', async () => {
    const calls = recordingCalls([7, 8]);
    const port = createPolicyDevicePort(calls, {});
    await port.snapshot();
    await port.press('@e12');
    await port.snapshot();
    await port.press('@e12');
    expect(calls.sent).toEqual(['snapshot~7', 'press @e12~s7', 'snapshot~8', 'press @e12~s8']);
  });

  test('sends a plain ref when the daemon issued no generation', async () => {
    const calls = recordingCalls([undefined]);
    const port = createPolicyDevicePort(calls, {});
    await port.snapshot();
    await port.press('e12');
    expect(calls.sent).toEqual(['snapshot~none', 'press @e12']);
  });

  test('reports a duration for every operation', async () => {
    const port = createPolicyDevicePort(recordingCalls([1]), {});
    const snapshot = await port.snapshot();
    expect(snapshot.ms).toBeGreaterThanOrEqual(0);
    expect(await port.press('@e1')).toBeGreaterThanOrEqual(0);
    expect(await port.fill('@e1', 'x')).toBeGreaterThanOrEqual(0);
  });

  test("carries the caller's device selection into every call", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const port = createPolicyDevicePort(
      {
        snapshot: async (options) => {
          seen.push(options);
          return { nodes: [] };
        },
        press: async (options) => {
          seen.push(options);
        },
        fill: async (options) => {
          seen.push(options);
        },
      },
      { udid: 'SIM-1' },
    );
    await port.snapshot();
    await port.press('@e1');
    expect(seen.every((options) => options.udid === 'SIM-1')).toBe(true);
    expect(seen[0]).toMatchObject({ interactiveOnly: true });
  });
});
