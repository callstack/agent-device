import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  NetworkDumpInput,
  NetworkProviderDumpResult,
  NetworkTransport,
  NetworkTransportScope,
} from '@agent-device/contracts/network-runtime';
import { captureNetworkProviderTraffic } from './network-provider-capture.ts';

const device: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'device-1',
  name: 'Device',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

const input: NetworkDumpInput = {
  sessionId: 'repro',
  appBundleId: 'com.example.app',
  stateDir: '/tmp/state',
  maxEntries: 25,
  include: 'summary',
  maxPayloadChars: 2048,
  maxScanLines: 2_000,
};

function hostWith(transport: NetworkTransport | undefined, resolveError?: Error) {
  const scopes: NetworkTransportScope[] = [];
  return {
    scopes,
    host: {
      networkTransports: {
        resolve: async (_device: DeviceInfo, scope?: NetworkTransportScope) => {
          if (resolveError) throw resolveError;
          if (scope) scopes.push(scope);
          if (!transport) throw new Error('no transport');
          return transport;
        },
      },
    },
  };
}

test('the provider result is handed back with the session scope the transport needs', async () => {
  const result: NetworkProviderDumpResult = {
    backend: 'react-native-app',
    entries: [{ url: 'https://api.test/x', method: 'GET', status: 200 }],
  };
  let seen: { maxEntries: number; include: string } | undefined;
  const fixture = hostWith({
    mode: 'transport-composed',
    dump: async (dumpInput) => {
      seen = dumpInput;
      return result;
    },
  });

  const capture = await captureNetworkProviderTraffic(
    fixture.host,
    device,
    input,
    new AbortController().signal,
    { resolveMetroDeviceIdentity: async () => 'Device' },
  );

  assert.deepEqual(capture, { status: 'captured', result });
  assert.deepEqual(seen, { maxEntries: 25, include: 'summary' });
  assert.equal(
    await fixture.scopes[0]?.resolveMetroDeviceIdentity?.(new AbortController().signal),
    'Device',
  );
  assert.deepEqual(
    { ...fixture.scopes[0], resolveMetroDeviceIdentity: undefined },
    {
      sessionId: 'repro',
      stateDir: '/tmp/state',
      appBundleId: 'com.example.app',
      maxPayloadChars: 2048,
      resolveMetroDeviceIdentity: undefined,
    },
  );
});

test('a caller without a device identity resolver reaches the transport without one; the dump fails closed', async () => {
  const fixture = hostWith({
    mode: 'transport-composed',
    dump: async () => ({ backend: 'react-native-app', entries: [] }),
  });

  await captureNetworkProviderTraffic(fixture.host, device, input, new AbortController().signal);

  assert.equal(fixture.scopes[0]?.resolveMetroDeviceIdentity, undefined);
});

test('a transport that declares no dump never calls the identity resolver: the probe stays unpaid', async () => {
  let probed = 0;
  const fixture = hostWith({ mode: 'local' });

  const capture = await captureNetworkProviderTraffic(
    fixture.host,
    device,
    input,
    new AbortController().signal,
    {
      resolveMetroDeviceIdentity: async () => {
        probed += 1;
        return 'Device';
      },
    },
  );

  assert.deepEqual(capture, { status: 'unavailable', notes: [] });
  assert.equal(probed, 0);
});

test('a session without an app id never probes a provider: injection needs a named app', async () => {
  const fixture = hostWith({
    mode: 'transport-composed',
    dump: async () => ({ backend: 'x', entries: [] }),
  });

  const capture = await captureNetworkProviderTraffic(
    fixture.host,
    device,
    { ...input, appBundleId: undefined },
    new AbortController().signal,
  );

  assert.deepEqual(capture, { status: 'unavailable', notes: [] });
  assert.equal(fixture.scopes.length, 0);
});

test('a provider that only armed its capture reports armed so the caller keeps its own source', async () => {
  const fixture = hostWith({
    mode: 'transport-composed',
    dump: async () => ({
      backend: 'react-native-app',
      entries: [],
      armed: true,
      notes: ['Capture was installed by this dump.'],
    }),
  });

  const capture = await captureNetworkProviderTraffic(
    fixture.host,
    device,
    input,
    new AbortController().signal,
  );

  assert.deepEqual(capture, {
    status: 'armed',
    notes: ['Capture was installed by this dump.'],
  });
});

test('an armed provider that already holds traffic is a capture, not an arming report', async () => {
  const result: NetworkProviderDumpResult = {
    backend: 'react-native-app',
    entries: [{ url: 'https://api.test/x' }],
    armed: true,
  };
  const fixture = hostWith({ mode: 'transport-composed', dump: async () => result });

  const capture = await captureNetworkProviderTraffic(
    fixture.host,
    device,
    input,
    new AbortController().signal,
  );

  assert.deepEqual(capture, { status: 'captured', result });
});

test('a missing provider transport is unavailable without a note, not an error', async () => {
  const fixture = hostWith({ mode: 'local' });

  const capture = await captureNetworkProviderTraffic(
    fixture.host,
    device,
    input,
    new AbortController().signal,
  );

  assert.deepEqual(capture, { status: 'unavailable', notes: [] });
});

test('a provider that cannot answer degrades to one typed note instead of throwing', async () => {
  const fixture = hostWith({
    mode: 'transport-composed',
    dump: async () => {
      throw new Error('No React Native runtime is connected to the dev server.');
    },
  });

  const capture = await captureNetworkProviderTraffic(
    fixture.host,
    device,
    input,
    new AbortController().signal,
  );

  assert.equal(capture.status, 'unavailable');
  const notes = capture.status === 'unavailable' ? capture.notes : [];
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /No React Native runtime is connected/);
  assert.match(notes[0]!, /reads the session app log instead/);
});

test('a session abort still fails the dump instead of hiding it as unavailable', async () => {
  const controller = new AbortController();
  const fixture = hostWith({
    mode: 'transport-composed',
    dump: async (_dumpInput, signal) => {
      controller.abort();
      signal?.throwIfAborted();
      throw new Error('aborted');
    },
  });

  await assert.rejects(
    captureNetworkProviderTraffic(fixture.host, device, input, controller.signal),
    /aborted/,
  );
});
