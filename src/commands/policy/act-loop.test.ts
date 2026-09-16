import { describe, expect, test } from 'vitest';
import { runPolicyActLoop, type PolicyDevicePort } from './act-loop.ts';
import type { PolicySnapshotNode } from './candidate-elements.ts';
import type { PolicyDecision, PolicyProvider, PolicyRequest } from './policy-contract.ts';

function decision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
  return {
    action: 'press',
    target: '@e6',
    done: false,
    blocked: false,
    needsText: false,
    confidence: 0.95,
    probabilities: { '@e6': 0.95 },
    provider: 'stub',
    model: 'stub-1',
    decideMs: 200,
    inputTokens: 400,
    costUsd: 0.0000168,
    ...overrides,
  };
}

function providerOf(...decisions: PolicyDecision[]): PolicyProvider & { seen: PolicyRequest[] } {
  const seen: PolicyRequest[] = [];
  let index = 0;
  return {
    name: 'stub',
    model: 'stub-1',
    seen,
    decide: async (request) => {
      seen.push(request);
      return decisions[Math.min(index++, decisions.length - 1)] as PolicyDecision;
    },
  };
}

function screenOf(...nodes: PolicySnapshotNode[]): PolicySnapshotNode[] {
  return nodes;
}

const welcome = screenOf(
  { index: 0, type: 'StaticText', label: 'Welcome', ref: 'e2' },
  { index: 1, type: 'Button', label: 'Send code', ref: 'e6' },
);
const codeScreen = screenOf(
  { index: 0, type: 'StaticText', label: 'Enter the code', ref: 'e2' },
  { index: 1, type: 'TextField', label: 'Code', identifier: 'codeField', value: '', ref: 'e7' },
);

/** A device that returns each queued screen in turn and records every call. */
function deviceOf(screens: PolicySnapshotNode[][]): PolicyDevicePort & { calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return {
    calls,
    snapshot: async () => {
      const nodes = screens[Math.min(index++, screens.length - 1)] as PolicySnapshotNode[];
      return { nodes, ms: 400 };
    },
    press: async (ref) => {
      calls.push(`press ${ref}`);
      return 900;
    },
    fill: async (ref, text) => {
      calls.push(`fill ${ref} ${text}`);
      return 700;
    },
  };
}

const baseOptions = {
  goal: 'sign in',
  inputs: new Map<string, string>(),
  env: {} as Record<string, string | undefined>,
  maxSteps: 6,
  minConfidence: 0.4,
  sleep: async () => {},
};

describe('policy act loop', () => {
  test('stops as done when the policy reports the goal achieved', async () => {
    const result = await runPolicyActLoop({
      ...baseOptions,
      provider: providerOf(decision({ done: true })),
      device: deviceOf([welcome]),
    });
    expect(result.status).toBe('done');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.outcome).toBe('done');
  });

  test('presses the chosen element and records the phase timings apart', async () => {
    const device = deviceOf([welcome, codeScreen]);
    const result = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      provider: providerOf(decision()),
      device,
    });
    expect(device.calls).toEqual(['press @e6']);
    expect(result.steps[0]).toMatchObject({
      outcome: 'acted',
      snapshotMs: 400,
      decideMs: 200,
      actionMs: 900,
      performed: { action: 'press', target: '@e6' },
    });
    expect(result.totals.costUsd).toBeCloseTo(0.0000168, 9);
  });

  test('re-reads once before filing an action as dead, so a slow transition still counts', async () => {
    // Two unchanged reads, then the transition lands: immediate read stale, grace read fresh.
    const device = deviceOf([welcome, welcome, codeScreen]);
    const result = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      provider: providerOf(decision()),
      device,
    });
    expect(result.steps[0]?.outcome).toBe('acted');
  });

  test('records an action that left the screen unchanged as a dead action', async () => {
    const result = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      provider: providerOf(decision()),
      device: deviceOf([welcome]),
    });
    expect(result.steps[0]?.outcome).toBe('dead-action');
    expect(result.steps[0]?.reason).toBe('screen unchanged after press');
    expect(result.totals.deadActions).toBe(1);
  });

  test('ends as escalated after three unproductive steps in a row', async () => {
    const result = await runPolicyActLoop({
      ...baseOptions,
      provider: providerOf(decision()),
      device: deviceOf([welcome]),
    });
    expect(result.status).toBe('escalated');
    expect(result.steps).toHaveLength(3);
  });

  test('escalates rather than acting below the confidence floor', async () => {
    const result = await runPolicyActLoop({
      ...baseOptions,
      minConfidence: 0.8,
      provider: providerOf(decision({ confidence: 0.3 })),
      device: deviceOf([welcome]),
    });
    expect(result.status).toBe('escalated');
    expect(result.steps[0]?.reason).toContain('below --min-confidence');
  });

  test('acts through a blocked flag only when confidence is very high', async () => {
    const acting = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      provider: providerOf(decision({ blocked: true, confidence: 0.99 })),
      device: deviceOf([welcome, codeScreen]),
    });
    expect(acting.steps[0]?.outcome).toBe('acted');

    const halted = await runPolicyActLoop({
      ...baseOptions,
      provider: providerOf(decision({ blocked: true, confidence: 0.7 })),
      device: deviceOf([welcome]),
    });
    expect(halted.status).toBe('blocked');
  });

  test('never invents text: a field with no supplied value escalates', async () => {
    const device = deviceOf([codeScreen]);
    const result = await runPolicyActLoop({
      ...baseOptions,
      provider: providerOf(decision({ action: 'fill', target: '@e7', needsText: true })),
      device,
    });
    expect(device.calls).toEqual([]);
    expect(result.status).toBe('escalated');
    expect(result.steps[0]?.reason).toBe('no text supplied for codeField');
  });

  test('fills from an input entry matched to the field identifier', async () => {
    const device = deviceOf([codeScreen, welcome]);
    const result = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['code', 'abcdef']]),
      provider: providerOf(decision({ action: 'fill', target: '@e7', needsText: true })),
      device,
    });
    expect(device.calls).toEqual(['fill @e7 abcdef']);
    expect(result.steps[0]?.performed).toEqual({
      action: 'fill',
      target: '@e7',
      entry: 'fill',
      inputKey: 'code',
    });
  });

  test('records the input key but never the text it sent', async () => {
    const result = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['code', '482493']]),
      provider: providerOf(decision({ action: 'fill', target: '@e7', needsText: true })),
      device: deviceOf([codeScreen, welcome]),
    });
    expect(JSON.stringify(result)).not.toContain('482493');
  });

  test('enters digits on the keypad when fill leaves the field value unchanged', async () => {
    const keypad: PolicySnapshotNode[] = [
      ...codeScreen,
      { index: 9, type: 'Key', label: '4', ref: 'e30' },
      { index: 10, type: 'Key', label: '8', ref: 'e31' },
    ];
    const device = deviceOf([keypad]);
    await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['code', '48']]),
      provider: providerOf(decision({ action: 'fill', target: '@e7', needsText: true })),
      device,
    });
    expect(device.calls).toEqual(['fill @e7 48', 'press @e30', 'press @e31']);
  });

  test('keeps a fill that did land off the keypad path', async () => {
    const landed: PolicySnapshotNode[] = [
      { index: 0, type: 'StaticText', label: 'Enter the code', ref: 'e2' },
      {
        index: 1,
        type: 'TextField',
        label: 'Code',
        identifier: 'codeField',
        value: '482493',
        ref: 'e7',
      },
      { index: 9, type: 'Key', label: '4', ref: 'e30' },
    ];
    const device = deviceOf([codeScreen, landed]);
    await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['code', '482493']]),
      provider: providerOf(decision({ action: 'fill', target: '@e7', needsText: true })),
      device,
    });
    expect(device.calls).toEqual(['fill @e7 482493']);
  });

  test('rewrites a field whose value is not the supplied text', async () => {
    const prefilled: PolicySnapshotNode[] = [
      { index: 0, type: 'StaticText', label: 'Welcome', ref: 'e2' },
      {
        index: 1,
        type: 'TextField',
        label: 'Phone number',
        identifier: 'phoneField',
        value: '(555) 555-0100',
        ref: 'e7',
      },
    ];
    const device = deviceOf([prefilled, welcome]);
    await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['phone', '5555550700']]),
      provider: providerOf(decision({ action: 'press', target: '@e7' })),
      device,
    });
    expect(device.calls).toEqual(['fill @e7 5555550700']);
  });

  test('presses rather than rewrites a field that already holds the supplied text', async () => {
    const satisfied: PolicySnapshotNode[] = [
      { index: 0, type: 'StaticText', label: 'Welcome', ref: 'e2' },
      {
        index: 1,
        type: 'TextField',
        label: 'Phone number',
        identifier: 'phoneField',
        value: '(555) 555-0700',
        ref: 'e7',
      },
    ];
    const device = deviceOf([satisfied, welcome]);
    await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['phone', '5555550700']]),
      provider: providerOf(decision({ action: 'press', target: '@e7' })),
      device,
    });
    expect(device.calls).toEqual(['press @e7']);
  });

  test('presses a field that already holds text when the caller supplied none', async () => {
    const prefilled: PolicySnapshotNode[] = [
      { index: 0, type: 'StaticText', label: 'Welcome', ref: 'e2' },
      {
        index: 1,
        type: 'TextField',
        label: 'Phone number',
        identifier: 'phoneField',
        value: '(555) 555-0100',
        ref: 'e7',
      },
    ];
    const device = deviceOf([prefilled, welcome]);
    await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      provider: providerOf(decision({ action: 'press', target: '@e7' })),
      device,
    });
    expect(device.calls).toEqual(['press @e7']);
  });

  test('reaches a digit-box widget through the keypad even when the write itself failed', async () => {
    const boxes: PolicySnapshotNode[] = [
      { index: 0, type: 'StaticText', label: '0 of 2 entered', ref: 'e2' },
      { index: 1, type: 'TextField', label: 'Code', identifier: 'codeField', value: '', ref: 'e7' },
      { index: 9, type: 'Key', label: '4', ref: 'e30' },
      { index: 10, type: 'Key', label: '8', ref: 'e31' },
    ];
    const device = deviceOf([boxes]);
    const failing: PolicyDevicePort = {
      ...device,
      fill: async () => {
        throw Object.assign(new Error('runner recorded a failure'), {
          code: 'XCTEST_RECORDED_FAILURE',
        });
      },
    };
    const result = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['code', '48']]),
      provider: providerOf(decision({ action: 'fill', target: '@e7', needsText: true })),
      device: failing,
    });
    expect(device.calls).toEqual(['press @e30', 'press @e31']);
    expect(result.steps[0]?.performed?.entry).toBe('keypad');
    expect(result.steps[0]?.outcome).toBe('acted');
  });

  test('accepts a hidden-value widget when the screen moved on after the write', async () => {
    // A digit-box code field never reflects its value; the next screen is the only evidence.
    const device = deviceOf([codeScreen, codeScreen, welcome]);
    const failing: PolicyDevicePort = {
      ...device,
      fill: async () => {
        throw Object.assign(new Error('recorded failure'), { code: 'XCTEST_RECORDED_FAILURE' });
      },
    };
    const result = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['code', 'abcdef']]),
      provider: providerOf(decision({ action: 'fill', target: '@e7', needsText: true })),
      device: failing,
    });
    expect(result.steps[0]?.outcome).toBe('acted');
  });

  test('carries the write failure code when neither the write nor the keypad delivered', async () => {
    const device = deviceOf([codeScreen]);
    const failing: PolicyDevicePort = {
      ...device,
      fill: async () => {
        throw Object.assign(new Error('mismatch'), { code: 'TEXT_ENTRY_MISMATCH' });
      },
    };
    const result = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['code', '48']]),
      provider: providerOf(decision({ action: 'fill', target: '@e7', needsText: true })),
      device: failing,
    });
    expect(result.steps[0]?.outcome).toBe('dead-action');
    expect(result.steps[0]?.reason).toContain('TEXT_ENTRY_MISMATCH');
  });

  test('accepts a masked field that reformatted the supplied text', async () => {
    const masked: PolicySnapshotNode[] = [
      { index: 0, type: 'StaticText', label: 'Welcome', ref: 'e2' },
      {
        index: 1,
        type: 'TextField',
        label: 'Phone number',
        identifier: 'phoneField',
        value: '(500) 555-0700',
        ref: 'e7',
      },
    ];
    const unformatted: PolicySnapshotNode[] = [
      { index: 0, type: 'StaticText', label: 'Welcome', ref: 'e2' },
      {
        index: 1,
        type: 'TextField',
        label: 'Phone number',
        identifier: 'phoneField',
        value: '',
        ref: 'e7',
      },
    ];
    const device = deviceOf([unformatted, masked]);
    const failing: PolicyDevicePort = {
      ...device,
      fill: async (ref, text) => {
        device.calls.push(`fill ${ref} ${text}`);
        throw Object.assign(new Error('mismatch'), { code: 'TEXT_ENTRY_MISMATCH' });
      },
    };
    const result = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['phone', '5005550700']]),
      provider: providerOf(decision({ action: 'fill', target: '@e7', needsText: true })),
      device: failing,
    });
    expect(device.calls).toEqual(['fill @e7 5005550700']);
    expect(result.steps[0]?.outcome).toBe('acted');
    expect(result.steps[0]?.performed?.entry).toBe('fill');
  });

  test('tells the policy which fields it already holds text for', async () => {
    const provider = providerOf(decision({ target: '@e7', action: 'fill' }));
    await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 1,
      inputs: new Map([['code', 'abc']]),
      provider,
      device: deviceOf([codeScreen, welcome]),
    });
    expect(provider.seen[0]?.textReadyRefs).toEqual(['@e7']);
  });

  test('gives the policy the history of what it already did', async () => {
    const provider = providerOf(decision());
    await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 2,
      provider,
      device: deviceOf([welcome, codeScreen, welcome, codeScreen]),
    });
    expect(provider.seen[0]?.history).toEqual([]);
    expect(provider.seen[1]?.history).toEqual(['pressed Send code']);
  });

  test('stops at the step budget', async () => {
    const result = await runPolicyActLoop({
      ...baseOptions,
      maxSteps: 2,
      provider: providerOf(decision()),
      device: deviceOf([welcome, codeScreen, welcome, codeScreen]),
    });
    expect(result.status).toBe('max-steps');
    expect(result.totals.steps).toBe(2);
  });
});
