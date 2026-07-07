import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRpcOk } from '../provider-scenarios/assertions.ts';
import type { ProviderScenarioTranscript } from '../provider-scenarios/transcript.ts';
import { RUNNER_CONTINUE_NODES } from './fixtures.ts';
import {
  CONTRACT_APP,
  runnerLongPressEntry,
  runnerSnapshotEntry,
  runnerTapEntry,
  runnerTypeEntry,
  withIosContractDaemon,
} from './daemon-harness.ts';

type WireData = Record<string, unknown>;

const REF_KEYS = [
  'message',
  'ref',
  'refLabel',
  'referenceHeight',
  'referenceWidth',
  'selectorChain',
  'targetKind',
  'x',
  'y',
] as const;

const SELECTOR_KEYS = [
  'message',
  'refLabel',
  'referenceHeight',
  'referenceWidth',
  'selector',
  'selectorChain',
  'targetKind',
  'x',
  'y',
] as const;

const POINT_KEYS = ['message', 'targetKind', 'x', 'y'] as const;

const NOISY_DEFAULT_TAP_RESULT = {
  count: 1,
  currentUptimeMs: 1_418_719_052.9,
  doubleTap: false,
  gestureEndUptimeMs: 1_418_719_052.338875,
  gestureStartUptimeMs: 1_418_718_741.4275,
  holdMs: 0,
  intervalMs: 0,
  jitterPx: 0,
};

test('interaction response shape: press @ref uses the canonical ref envelope', async () => {
  await withIosContractDaemon(
    [runnerSnapshotEntry(RUNNER_CONTINUE_NODES), runnerTapEntry(NOISY_DEFAULT_TAP_RESULT)],
    async (daemon, transcript) => {
      assertRpcOk(await daemon.callCommand('snapshot', [], { snapshotInteractiveOnly: true }));

      const data = assertRpcOk(await daemon.callCommand('press', ['@e2']));
      assertRunnerRequest(transcript, 'ios.runner.tap', tapRequest(200, 322));

      assertCanonicalRef(data, {
        message: 'Tapped @e2 (200, 322)',
        x: 200,
        y: 322,
      });
    },
  );
});

test('interaction response shape: fill @ref uses the canonical ref envelope', async () => {
  await withIosContractDaemon(
    [runnerSnapshotEntry(RUNNER_CONTINUE_NODES), runnerTypeEntry({})],
    async (daemon, transcript) => {
      assertRpcOk(await daemon.callCommand('snapshot', [], { snapshotInteractiveOnly: true }));

      const data = assertRpcOk(await daemon.callCommand('fill', ['@e2', 'Hello']));
      assertRunnerRequest(transcript, 'ios.runner.type', typeRequest(200, 322, 'Hello'));

      assertCanonicalRef(data, {
        message: 'Filled 5 chars',
        x: 200,
        y: 322,
        extra: {
          delayMs: 0,
          text: 'Hello',
          warning: 'fill target @e2 resolved to "Button", attempting fill anyway.',
        },
      });
    },
  );
});

test('interaction response shape: longpress @ref uses the canonical ref envelope', async () => {
  await withIosContractDaemon(
    [runnerSnapshotEntry(RUNNER_CONTINUE_NODES), runnerLongPressEntry({})],
    async (daemon, transcript) => {
      assertRpcOk(await daemon.callCommand('snapshot', [], { snapshotInteractiveOnly: true }));

      const data = assertRpcOk(await daemon.callCommand('longpress', ['@e2', '700']));
      assertRunnerRequest(transcript, 'ios.runner.longPress', longPressRequest(200, 322, 700));

      assertCanonicalRef(data, {
        message: 'Long pressed @e2 (200, 322)',
        x: 200,
        y: 322,
        extra: { durationMs: 700, gesture: 'longpress' },
      });
    },
  );
});

test('interaction response shape: press selector uses the canonical selector envelope', async () => {
  await withIosContractDaemon(
    [runnerSnapshotEntry(RUNNER_CONTINUE_NODES), runnerTapEntry({})],
    async (daemon, transcript) => {
      const data = assertRpcOk(await daemon.callCommand('press', ['label=Continue']));
      assertRunnerRequest(transcript, 'ios.runner.tap', tapRequest(200, 322));

      assertCanonicalSelector(data, {
        message: 'Tapped label=Continue (200, 322)',
        x: 200,
        y: 322,
      });
    },
  );
});

test('interaction response shape: fill selector uses the canonical selector envelope', async () => {
  await withIosContractDaemon(
    [runnerTypeEntry({ ...NOISY_DEFAULT_TAP_RESULT, x: 200, y: 322 })],
    async (daemon, transcript) => {
      const data = assertRpcOk(await daemon.callCommand('fill', ['label=Continue', 'Hello']));
      assertRunnerRequest(transcript, 'ios.runner.type', selectorTypeRequest('Hello'));

      assertCanonicalDirectSelector(data, {
        message: 'Filled 5 chars',
        x: 200,
        y: 322,
        extra: { delayMs: 0, text: 'Hello' },
      });
    },
  );
});

test('interaction response shape: longpress selector uses the canonical selector envelope', async () => {
  await withIosContractDaemon(
    [runnerSnapshotEntry(RUNNER_CONTINUE_NODES), runnerLongPressEntry({})],
    async (daemon, transcript) => {
      const data = assertRpcOk(await daemon.callCommand('longpress', ['label=Continue', '700']));
      assertRunnerRequest(transcript, 'ios.runner.longPress', longPressRequest(200, 322, 700));

      assertCanonicalSelector(data, {
        message: 'Long pressed label=Continue (200, 322)',
        x: 200,
        y: 322,
        extra: { durationMs: 700, gesture: 'longpress' },
      });
    },
  );
});

test('interaction response shape: press point uses the canonical point envelope', async () => {
  await withIosContractDaemon([runnerTapEntry({})], async (daemon, transcript) => {
    const data = assertRpcOk(await daemon.callCommand('press', ['100', '200']));
    assertRunnerRequest(transcript, 'ios.runner.tap', tapRequest(100, 200));

    assertCanonicalPoint(data, {
      message: 'Tapped (100, 200)',
      x: 100,
      y: 200,
    });
  });
});

test('interaction response shape: fill point uses the canonical point envelope', async () => {
  await withIosContractDaemon([runnerTypeEntry({})], async (daemon, transcript) => {
    const data = assertRpcOk(await daemon.callCommand('fill', ['100', '200', 'Hello']));
    assertRunnerRequest(transcript, 'ios.runner.type', typeRequest(100, 200, 'Hello'));

    assertCanonicalPoint(data, {
      message: 'Filled 5 chars',
      x: 100,
      y: 200,
      extra: { delayMs: 0, text: 'Hello' },
    });
  });
});

test('interaction response shape: longpress point uses the canonical point envelope', async () => {
  await withIosContractDaemon([runnerLongPressEntry({})], async (daemon, transcript) => {
    const data = assertRpcOk(await daemon.callCommand('longpress', ['100', '200', '700']));
    assertRunnerRequest(transcript, 'ios.runner.longPress', longPressRequest(100, 200, 700));

    assertCanonicalPoint(data, {
      message: 'Long pressed (100, 200)',
      x: 100,
      y: 200,
      extra: { durationMs: 700, gesture: 'longpress' },
    });
  });
});

function assertCanonicalRef(
  data: WireData,
  expected: { message: string; x: number; y: number; extra?: WireData },
): void {
  assertExactKeys(data, [...REF_KEYS, ...Object.keys(expected.extra ?? {})]);
  assert.deepEqual(
    pick(data, [
      'message',
      'ref',
      'refLabel',
      'referenceHeight',
      'referenceWidth',
      'targetKind',
      'x',
      'y',
      ...Object.keys(expected.extra ?? {}),
    ]),
    {
      message: expected.message,
      ref: 'e2',
      refLabel: 'Continue',
      referenceHeight: 800,
      referenceWidth: 400,
      targetKind: 'ref',
      x: expected.x,
      y: expected.y,
      ...(expected.extra ?? {}),
    },
  );
  assertSelectorChain(data);
  assertNoWireNoise(data);
}

function assertCanonicalSelector(
  data: WireData,
  expected: { message: string; x: number; y: number; extra?: WireData },
): void {
  assertExactKeys(data, [...SELECTOR_KEYS, ...Object.keys(expected.extra ?? {})]);
  assert.deepEqual(
    pick(data, [
      'message',
      'refLabel',
      'referenceHeight',
      'referenceWidth',
      'selector',
      'targetKind',
      'x',
      'y',
      ...Object.keys(expected.extra ?? {}),
    ]),
    {
      message: expected.message,
      refLabel: 'Continue',
      referenceHeight: 800,
      referenceWidth: 400,
      selector: 'label=Continue',
      targetKind: 'selector',
      x: expected.x,
      y: expected.y,
      ...(expected.extra ?? {}),
    },
  );
  assertSelectorChain(data);
  assertNoWireNoise(data);
}

function assertCanonicalDirectSelector(
  data: WireData,
  expected: { message: string; x: number; y: number; extra?: WireData },
): void {
  assertExactKeys(data, [
    'message',
    'selector',
    'targetKind',
    'x',
    'y',
    ...Object.keys(expected.extra ?? {}),
  ]);
  assert.deepEqual(
    pick(data, [
      'message',
      'selector',
      'targetKind',
      'x',
      'y',
      ...Object.keys(expected.extra ?? {}),
    ]),
    {
      message: expected.message,
      selector: 'label=Continue',
      targetKind: 'selector',
      x: expected.x,
      y: expected.y,
      ...(expected.extra ?? {}),
    },
  );
  assertNoWireNoise(data);
}

function assertCanonicalPoint(
  data: WireData,
  expected: { message: string; x: number; y: number; extra?: WireData },
): void {
  assertExactKeys(data, [...POINT_KEYS, ...Object.keys(expected.extra ?? {})]);
  assert.deepEqual(
    pick(data, ['message', 'targetKind', 'x', 'y', ...Object.keys(expected.extra ?? {})]),
    {
      message: expected.message,
      targetKind: 'point',
      x: expected.x,
      y: expected.y,
      ...(expected.extra ?? {}),
    },
  );
  assertNoWireNoise(data);
}

function assertSelectorChain(data: WireData): void {
  assert.ok(Array.isArray(data.selectorChain), 'selectorChain must be present');
  assert.ok(data.selectorChain.length > 0, 'selectorChain must be non-empty');
}

function assertExactKeys(data: WireData, expectedKeys: readonly string[]): void {
  assert.deepEqual(Object.keys(data).sort(), [...expectedKeys].sort());
}

function assertNoWireNoise(data: WireData): void {
  for (const key of [
    'count',
    'currentUptimeMs',
    'doubleTap',
    'gestureEndUptimeMs',
    'gestureStartUptimeMs',
    'holdMs',
    'intervalMs',
    'jitterPx',
    'sequenceResults',
  ]) {
    assert.equal(data[key], undefined, `${key} should not be in the wire response`);
  }
}

function assertRunnerRequest(
  transcript: ProviderScenarioTranscript,
  command: string,
  expected: WireData,
): void {
  const call = [...transcript.calls].reverse().find((entry) => entry.command === command);
  assert.ok(call, `Expected transcript to include ${command}`);
  assert.deepEqual(stripUndefined(call.request as WireData), expected);
}

function pick(data: WireData, keys: readonly string[]): WireData {
  return Object.fromEntries(keys.map((key) => [key, data[key]]));
}

function stripUndefined(data: WireData): WireData {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

function tapRequest(x: number, y: number): WireData {
  return { command: 'tap', x, y, synthesized: true, appBundleId: CONTRACT_APP };
}

function typeRequest(x: number, y: number, text: string): WireData {
  return {
    command: 'type',
    x,
    y,
    text,
    delayMs: 0,
    textEntryMode: 'replace',
    appBundleId: CONTRACT_APP,
  };
}

function selectorTypeRequest(text: string): WireData {
  return {
    command: 'type',
    selectorKey: 'label',
    selectorValue: 'Continue',
    text,
    delayMs: 0,
    textEntryMode: 'replace',
    appBundleId: CONTRACT_APP,
  };
}

function longPressRequest(x: number, y: number, durationMs: number): WireData {
  return { command: 'longPress', x, y, durationMs, appBundleId: CONTRACT_APP };
}
