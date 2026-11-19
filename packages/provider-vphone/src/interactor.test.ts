import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTest } from '@agent-device/test-kit';
import { PNG } from '@agent-device/capture-kit/png';
import { test } from 'vitest';
import { createVphoneInteractor } from './interactor.ts';
import {
  createRecordingVphoneTransport,
  rpcMethods,
  vphoneFixtureResponse,
} from './transport.fixtures.ts';

const VALID_PNG = PNG.sync.write(new PNG({ width: 2, height: 1 }));
const PNG_SIGNATURE_ONLY = VALID_PNG.subarray(0, 8);

test('terminateRunningApp terminates before launch and preserves the URL', async () => {
  const fixture = createRecordingVphoneTransport();
  const interactor = createVphoneInteractor({ transport: fixture.transport, machine: 'machine-a' });

  await interactor.open('com.example.app', { terminateRunningApp: true, url: 'example://home' });

  assert.deepEqual(rpcMethods(fixture.calls), ['apps.terminate', 'apps.launch']);
  assert.deepEqual(fixture.calls[1], {
    kind: 'rpc',
    machine: 'machine-a',
    method: 'apps.launch',
    params: { bundle_id: 'com.example.app', url: 'example://home' },
  });
});

test('unsupported launch arguments and excluded operations reject without RPC', async () => {
  const fixture = createRecordingVphoneTransport();
  const interactor = createVphoneInteractor({ transport: fixture.transport, machine: 'machine-a' });

  await assert.rejects(interactor.open('com.example.app', { launchArgs: ['-fixture'] }), {
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'vphone_launch_args_unsupported' },
  });
  await assert.rejects(interactor.fill(1, 2, 'replacement'), { code: 'UNSUPPORTED_OPERATION' });
  await assert.rejects(interactor.back(), { code: 'UNSUPPORTED_OPERATION' });
  await assert.rejects(interactor.setOrientation('landscape-left'), {
    code: 'UNSUPPORTED_OPERATION',
  });
  assert.deepEqual(fixture.calls, []);
});

test('point, double, long, focus, and text input keep screen-point parameters', async () => {
  const fixture = createRecordingVphoneTransport();
  const interactor = createVphoneInteractor({ transport: fixture.transport, machine: 'machine-a' });

  await interactor.tap(10.5, 20.25);
  await interactor.doubleTap!(30, 40);
  await interactor.longPress(50, 60, 1250);
  await interactor.focus(70, 80);
  await interactor.type('hello', 25);

  assert.deepEqual(
    fixture.calls.map(
      (call) => call.kind === 'rpc' && { method: call.method, params: call.params },
    ),
    [
      { method: 'input.tap', params: { x: 10.5, y: 20.25 } },
      { method: 'input.double_tap', params: { x: 30, y: 40 } },
      { method: 'input.long_press', params: { x: 50, y: 60, seconds: 1.25 } },
      { method: 'input.tap', params: { x: 70, y: 80 } },
      { method: 'input.type', params: { text: 'hello', delay_ms: 25 } },
    ],
  );
});

test.each([
  { key: 'id', expected: { x: 25, y: 40 } },
  { key: 'label', expected: { x: 5, y: 5 } },
  { key: 'text', expected: { x: 5, y: 5 } },
] as const)(
  'semantic $key tap resolves only its exact snapshot field',
  async ({ key, expected }) => {
    const fixture = createRecordingVphoneTransport((call) => {
      if (call.kind === 'rpc' && call.method === 'ui.tree') {
        return {
          elements: [
            {
              identifier: 'other',
              label: 'target',
              value: 'different',
              frame: { x: 0, y: 0, width: 10, height: 10 },
            },
            {
              identifier: 'target',
              label: 'other',
              value: 1,
              visible: 1,
              frame: { x: 10, y: 20, width: 30, height: 40 },
            },
          ],
        };
      }
      return vphoneFixtureResponse(call);
    });
    const interactor = createVphoneInteractor({
      transport: fixture.transport,
      machine: 'machine-a',
    });

    await interactor.tapElementSelector!({ key, value: 'target' });

    assert.deepEqual(
      fixture.calls.map((call) => call.kind === 'rpc' && call.method),
      ['ui.tree', 'input.tap'],
    );
    assert.deepEqual(fixture.calls.at(-1), {
      kind: 'rpc',
      machine: 'machine-a',
      method: 'input.tap',
      params: expected,
    });
  },
);

test.each([
  { raw: 'target', wanted: 'target' },
  { raw: 1, wanted: '1' },
  { raw: true, wanted: 'true' },
])(
  'value semantic tap normalizes $wanted like snapshots and ignores labels',
  async ({ raw, wanted }) => {
    const fixture = createRecordingVphoneTransport((call) => {
      if (call.kind === 'rpc' && call.method === 'ui.tree') {
        return {
          elements: [
            { label: wanted, value: 'other', frame: { x: 0, y: 0, width: 10, height: 10 } },
            {
              label: 'other',
              value: raw,
              visible: 1,
              frame: { x: 10, y: 20, width: 30, height: 40 },
            },
          ],
        };
      }
      return vphoneFixtureResponse(call);
    });
    const interactor = createVphoneInteractor({
      transport: fixture.transport,
      machine: 'machine-a',
    });

    await interactor.tapElementSelector!({ key: 'value', value: wanted });

    assert.deepEqual(fixture.calls.at(-1), {
      kind: 'rpc',
      machine: 'machine-a',
      method: 'input.tap',
      params: { x: 25, y: 40 },
    });
  },
);

test.each([
  { durationMs: 50_000, timeoutMs: 65_000 },
  { durationMs: 60_000, timeoutMs: 75_000 },
])(
  'long press allows $durationMs ms with a hold-aware transport timeout',
  async ({ durationMs, timeoutMs }) => {
    const fixture = createRecordingVphoneTransport();
    const interactor = createVphoneInteractor({
      transport: fixture.transport,
      machine: 'machine-a',
    });

    await interactor.longPress(10, 20, durationMs);

    assert.deepEqual(fixture.calls, [
      {
        kind: 'rpc',
        machine: 'machine-a',
        method: 'input.long_press',
        params: { x: 10, y: 20, seconds: durationMs / 1000 },
        timeoutMs,
      },
    ]);
  },
);

test("long press rejects durations above vphone's 60-second limit without RPC", async () => {
  const fixture = createRecordingVphoneTransport();
  const interactor = createVphoneInteractor({ transport: fixture.transport, machine: 'machine-a' });

  await assert.rejects(interactor.longPress(10, 20, 60_001), {
    code: 'INVALID_ARGS',
    details: { reason: 'vphone_long_press_duration_invalid' },
  });
  assert.deepEqual(fixture.calls, []);
});

test.each([
  { node: { value: 'Fallback Value', identifier: 'other' }, query: ' fallback   value ' },
  { node: { identifier: 'Fallback-ID' }, query: 'FALLBACK-ID' },
])('text selector falls back through value and identifier: $query', async ({ node, query }) => {
  const fixture = createRecordingVphoneTransport((call) => {
    if (call.kind === 'rpc' && call.method === 'ui.tree') {
      return {
        elements: [
          {
            ...node,
            visible: 1,
            enabled: true,
            frame: { x: 10, y: 20, width: 30, height: 40 },
          },
        ],
      };
    }
    return vphoneFixtureResponse(call);
  });
  const interactor = createVphoneInteractor({ transport: fixture.transport, machine: 'machine-a' });

  await interactor.tapElementSelector!({ key: 'text', value: query });

  assert.deepEqual(fixture.calls.at(-1), {
    kind: 'rpc',
    machine: 'machine-a',
    method: 'input.tap',
    params: { x: 25, y: 40 },
  });
});

test.each([
  { key: 'id', node: { identifier: '  Alpha   Beta  ' } },
  { key: 'label', node: { label: '  Alpha   Beta  ' } },
  { key: 'text', node: { label: '  Alpha   Beta  ' } },
  { key: 'value', node: { value: '  Alpha   Beta  ' } },
] as const)(
  '$key selector applies shared case and whitespace normalization',
  async ({ key, node }) => {
    const fixture = createRecordingVphoneTransport((call) => {
      if (call.kind === 'rpc' && call.method === 'ui.tree') {
        return {
          elements: [
            {
              ...node,
              visible: 1,
              enabled: true,
              frame: { x: 10, y: 20, width: 30, height: 40 },
            },
          ],
        };
      }
      return vphoneFixtureResponse(call);
    });
    const interactor = createVphoneInteractor({
      transport: fixture.transport,
      machine: 'machine-a',
    });

    await interactor.tapElementSelector!({ key, value: ' alpha beta ' });

    assert.deepEqual(fixture.calls.at(-1), {
      kind: 'rpc',
      machine: 'machine-a',
      method: 'input.tap',
      params: { x: 25, y: 40 },
    });
  },
);

test.each([-1, 1_001, Number.NaN, Number.POSITIVE_INFINITY])(
  'type rejects unsupported delay %s before RPC',
  async (delayMs) => {
    const fixture = createRecordingVphoneTransport();
    const interactor = createVphoneInteractor({
      transport: fixture.transport,
      machine: 'machine-a',
    });

    await assert.rejects(interactor.type('text', delayMs), {
      code: 'INVALID_ARGS',
      details: { reason: 'vphone_type_delay_invalid' },
    });
    assert.deepEqual(fixture.calls, []);
  },
);

test('type computes its timeout from character count and delay', async () => {
  const fixture = createRecordingVphoneTransport();
  const interactor = createVphoneInteractor({ transport: fixture.transport, machine: 'machine-a' });
  const text = 'x'.repeat(1_000);

  await interactor.type(text, 500);

  assert.deepEqual(fixture.calls, [
    {
      kind: 'rpc',
      machine: 'machine-a',
      method: 'input.type',
      params: { text, delay_ms: 500 },
      timeoutMs: 515_000,
    },
  ]);
});

test('type rejects a character-delay budget above the transport maximum before RPC', async () => {
  const fixture = createRecordingVphoneTransport();
  const interactor = createVphoneInteractor({ transport: fixture.transport, machine: 'machine-a' });

  await assert.rejects(interactor.type('x'.repeat(586), 1_000), {
    code: 'INVALID_ARGS',
    details: {
      reason: 'vphone_type_timeout_exceeded',
      timeoutMs: 601_000,
      maximum: 600_000,
    },
  });
  assert.deepEqual(fixture.calls, []);
});

test('scroll uses device screen points without pixel conversion', async () => {
  const fixture = createRecordingVphoneTransport();
  const interactor = createVphoneInteractor({ transport: fixture.transport, machine: 'machine-a' });

  const plan = await interactor.scroll('up');

  assert.deepEqual(fixture.calls.at(-1), {
    kind: 'rpc',
    machine: 'machine-a',
    method: 'input.swipe',
    params: { from: [195, 169], to: [195, 675], seconds: 0.4, steps: 20 },
  });
  assert.equal(plan?.pixels, 506);
});

test('screenshot writes and validates a complete PNG', async () => {
  const directory = await mkdtempForTest('vphone-screenshot-');
  const output = path.join(directory, 'capture.png');
  const fixture = createRecordingVphoneTransport((call) => {
    if (call.kind === 'json') {
      const request = JSON.parse(call.args[3]!) as { path: string };
      fs.writeFileSync(request.path, VALID_PNG);
    }
    return { sent: true };
  });
  const interactor = createVphoneInteractor({ transport: fixture.transport, machine: 'machine-a' });

  await interactor.screenshot(output);

  assert.deepEqual(fs.readFileSync(output), VALID_PNG);
  assert.deepEqual(fixture.calls[0]?.kind === 'json' && fixture.calls[0].args.slice(0, 3), [
    'guest',
    'send',
    'machine-a',
  ]);
});

test.each([
  { name: 'arbitrary data', bytes: Buffer.from('not-a-png') },
  { name: 'signature only', bytes: PNG_SIGNATURE_ONLY },
  { name: 'truncated PNG', bytes: VALID_PNG.subarray(0, VALID_PNG.length - 5) },
])('screenshot rejects $name', async ({ bytes }) => {
  const directory = await mkdtempForTest('vphone-screenshot-invalid-');
  const output = path.join(directory, 'capture.png');
  const fixture = createRecordingVphoneTransport((call) => {
    if (call.kind === 'json') fs.writeFileSync(output, bytes);
    return { sent: true };
  });
  const interactor = createVphoneInteractor({ transport: fixture.transport, machine: 'machine-a' });

  await assert.rejects(interactor.screenshot(output), {
    details: { reason: 'vphone_screenshot_invalid' },
  });
});
