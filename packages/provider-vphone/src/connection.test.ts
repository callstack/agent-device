import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  createVphoneConnection,
  verifyVphoneMachine,
  VPHONE_REQUIRED_METHODS,
} from './connection.ts';
import { createRecordingVphoneTransport, vphoneFixtureResponse } from './transport.fixtures.ts';

test('connection selects only the named running machine and preflights required methods', async () => {
  const fixture = createRecordingVphoneTransport((call) => {
    if (call.kind === 'json') return [{ name: 'machine-a', state: 'running', udid: 'udid-a' }];
    return vphoneFixtureResponse(call);
  });

  const machine = await verifyVphoneMachine(fixture.transport, 'machine-a');
  assert.deepEqual(machine, { name: 'machine-a', state: 'running', udid: 'udid-a' });
  assert.deepEqual(
    fixture.calls.map((call) => call.kind),
    ['json', 'rpc'],
  );
  assert.equal(fixture.calls[1]?.kind === 'rpc' && fixture.calls[1].method, 'methods.list');
});

test('a stopped machine is refused without starting it or calling the guest', async () => {
  const fixture = createRecordingVphoneTransport(() => [{ name: 'machine-a', state: 'stopped' }]);
  await assert.rejects(verifyVphoneMachine(fixture.transport, 'machine-a'), {
    details: { reason: 'vphone_machine_not_running' },
  });
  assert.deepEqual(fixture.calls, [{ kind: 'json', args: ['vm', 'list'] }]);
});

test('missing required methods fail preflight with their names', async () => {
  const fixture = createRecordingVphoneTransport((call) => {
    if (call.kind === 'json') return vphoneFixtureResponse(call);
    return { methods: [{ name: 'device.info' }] };
  });
  await assert.rejects(verifyVphoneMachine(fixture.transport, 'machine-a'), (error: unknown) => {
    const details = (error as { details?: { reason?: string; missingMethods?: string[] } }).details;
    assert.equal(details?.reason, 'vphone_methods_missing');
    assert.deepEqual(
      details?.missingMethods,
      VPHONE_REQUIRED_METHODS.filter((name) => name !== 'device.info'),
    );
    return true;
  });
});

test('malformed machine inventory fails closed', async () => {
  const fixture = createRecordingVphoneTransport(() => ({ machines: [] }));
  await assert.rejects(verifyVphoneMachine(fixture.transport, 'machine-a'), {
    details: { reason: 'vphone_invalid_response' },
  });
});

test('resolve requires iOS and --device and refuses provisioning profile fields', () => {
  const connection = createVphoneConnection({}, createRecordingVphoneTransport().transport);
  const base = {
    json: false,
    help: false,
    version: false,
    platform: 'ios',
    device: 'machine-a',
  } as const;
  assert.deepEqual(connection.resolve({ flags: base }).profile, {
    leaseProvider: 'vphone',
    platform: 'ios',
    target: 'mobile',
    device: 'machine-a',
  });
  assert.throws(() => connection.resolve({ flags: { ...base, device: undefined } }), {
    code: 'INVALID_ARGS',
  });
  for (const flags of [
    { ...base, providerApp: '/fixture/app.ipa' },
    { ...base, providerOsVersion: '26.0' },
  ]) {
    assert.throws(() => connection.resolve({ flags }), { code: 'INVALID_ARGS' });
  }
});
