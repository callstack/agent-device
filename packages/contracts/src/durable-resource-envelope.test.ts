import assert from 'node:assert/strict';
import { test } from 'vitest';
import { APP_LOG_ENVELOPE_FIXTURE } from './durable-resource-envelope.fixtures.ts';
import { decodeDurableResourceEnvelope } from './durable-resource-envelope.ts';

test('neutral envelope decoding validates and freezes persisted JSON before facet selection', () => {
  const result = decodeDurableResourceEnvelope(
    JSON.parse(JSON.stringify(APP_LOG_ENVELOPE_FIXTURE)),
  );
  assert.equal(result.status, 'decoded');
  if (result.status !== 'decoded') return;

  assert.deepEqual(result.envelope, APP_LOG_ENVELOPE_FIXTURE);
  assert.ok(Object.isFrozen(result.envelope));
  assert.ok(Object.isFrozen(result.envelope.descriptor.body));
  assert.ok(Object.isFrozen(result.envelope.metadata));
});

test('neutral envelope decoding retains invalid and unsupported-version evidence', () => {
  const invalid = decodeDurableResourceEnvelope({
    ...APP_LOG_ENVELOPE_FIXTURE,
    owner: { kind: 'provider-runtime', provider: 'webdriver', instance: '   ' },
  });
  assert.deepEqual(invalid, {
    status: 'unreattachable',
    reason: 'descriptor-invalid',
    message: 'Durable resource owner reference is invalid',
  });

  const unsupported = decodeDurableResourceEnvelope({
    ...APP_LOG_ENVELOPE_FIXTURE,
    envelopeVersion: 7,
  });
  assert.deepEqual(unsupported, {
    status: 'unreattachable',
    reason: 'descriptor-version-unsupported',
    message: 'Unsupported durable resource envelope version: 7',
    version: 7,
  });
});

test.each([
  {
    name: 'local owner for another family',
    device: {
      ...APP_LOG_ENVELOPE_FIXTURE.device,
      family: 'apple',
      appleOs: 'ios',
      kind: 'device',
    },
    owner: APP_LOG_ENVELOPE_FIXTURE.owner,
  },
  {
    name: 'Apple leaf on a non-Apple family',
    device: { ...APP_LOG_ENVELOPE_FIXTURE.device, appleOs: 'ios' },
  },
  {
    name: 'Apple physical backend on a non-Apple family',
    device: {
      ...APP_LOG_ENVELOPE_FIXTURE.device,
      kind: 'device',
      iosPhysicalDeviceBackend: 'coredevice',
    },
  },
  {
    name: 'Apple family without a leaf',
    device: {
      id: 'apple-1',
      family: 'apple',
      kind: 'device',
      target: 'mobile',
    },
  },
  {
    name: 'physical backend on an Apple simulator',
    device: {
      id: 'simulator-1',
      family: 'apple',
      appleOs: 'ios',
      kind: 'simulator',
      target: 'mobile',
      iosPhysicalDeviceBackend: 'xctest',
    },
  },
])('neutral envelope rejects impossible device/owner identity: $name', ({ device, owner }) => {
  const outcome = decodeDurableResourceEnvelope({
    ...APP_LOG_ENVELOPE_FIXTURE,
    device,
    owner: owner ?? { kind: 'provider-runtime', provider: 'cloud', instance: 'tenant-1' },
  });

  assert.equal(outcome.status, 'unreattachable');
  if (outcome.status === 'unreattachable') assert.equal(outcome.reason, 'descriptor-invalid');
});

test('neutral envelope canonicalizes persisted provider owner identity', () => {
  const outcome = decodeDurableResourceEnvelope({
    ...APP_LOG_ENVELOPE_FIXTURE,
    owner: {
      kind: 'provider-runtime',
      provider: '  webdriver ',
      instance: ' tenant-a  ',
    },
  });

  assert.equal(outcome.status, 'decoded');
  if (outcome.status !== 'decoded') return;
  assert.deepEqual(outcome.envelope.owner, {
    kind: 'provider-runtime',
    provider: 'webdriver',
    instance: 'tenant-a',
  });
});

test('neutral envelope decoding rejects cyclic or unbounded descriptor bodies', () => {
  const cyclicBody: Record<string, unknown> = {};
  cyclicBody.self = cyclicBody;
  const cyclic = decodeDurableResourceEnvelope({
    ...APP_LOG_ENVELOPE_FIXTURE,
    descriptor: { version: 2, body: cyclicBody },
  });
  assert.equal(cyclic.status, 'unreattachable');
  if (cyclic.status === 'unreattachable') {
    assert.equal(cyclic.reason, 'descriptor-invalid');
  }

  let nested: Record<string, unknown> = {};
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  const tooDeep = decodeDurableResourceEnvelope({
    ...APP_LOG_ENVELOPE_FIXTURE,
    descriptor: { version: 2, body: nested },
  });
  assert.equal(tooDeep.status, 'unreattachable');
});
