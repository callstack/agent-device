import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

const metroReads = vi.hoisted(() => vi.fn());
const dumps = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/react-native', () => ({
  readMetroSessionRuntime: metroReads,
  dumpReactNativeAppNetwork: dumps,
}));

const { resolveReactNativeNetworkTransport } =
  await import('./platform-runtime-network-react-native-transport.ts');

const host = {} as HostEnvironment;

function device(platform: DeviceInfo['platform'], kind: DeviceInfo['kind'] = 'simulator') {
  return { platform, kind, id: 'device-1', name: 'device-1' } as DeviceInfo;
}

const scope = { sessionId: 's1', stateDir: '/state' };

test.afterEach(() => {
  metroReads.mockReset();
  dumps.mockReset();
});

test('a non-mobile device never resolves a React Native network transport', async () => {
  const transport = await resolveReactNativeNetworkTransport(device('web'), scope, host);
  assert.equal(transport.dump, undefined);
  assert.equal(metroReads.mock.calls.length, 0);
});

test('a session without a state dir has no Metro binding to read and is not probed', async () => {
  const transport = await resolveReactNativeNetworkTransport(
    device('apple'),
    { sessionId: 's1' },
    host,
  );
  assert.equal(transport.dump, undefined);
  assert.equal(metroReads.mock.calls.length, 0);
});

test('a session without a Metro hint answers local with no provider dump', async () => {
  metroReads.mockResolvedValue(undefined);
  const transport = await resolveReactNativeNetworkTransport(device('android'), scope, host);
  assert.equal(transport.dump, undefined);
  assert.equal(dumps.mock.calls.length, 0);
});

test('a session with a Metro binding dumps through the app-side capture with the session scope', async () => {
  metroReads.mockResolvedValue({ metroPort: 8081 });
  dumps.mockResolvedValue({ backend: 'react-native-app', entries: [] });
  const transport = await resolveReactNativeNetworkTransport(
    device('apple'),
    { ...scope, appBundleId: 'com.example.app', maxPayloadChars: 2048 },
    host,
  );
  assert.ok(transport.dump);
  const signal = new AbortController().signal;
  await transport.dump({ maxEntries: 25, include: 'all' }, signal);
  assert.deepEqual(dumps.mock.calls[0], [
    {
      stateDir: '/state',
      session: 's1',
      appBundleId: 'com.example.app',
      maxEntries: 25,
      include: 'all',
      maxPayloadChars: 2048,
    },
    signal,
  ]);
});

test('the identity resolver runs only inside the dump and its answer joins the dump input', async () => {
  metroReads.mockResolvedValue({ metroPort: 8081 });
  dumps.mockResolvedValue({ backend: 'react-native-app', entries: [] });
  let resolved = 0;
  const transport = await resolveReactNativeNetworkTransport(
    device('android'),
    {
      ...scope,
      appBundleId: 'com.example.app',
      resolveMetroDeviceIdentity: async () => {
        resolved += 1;
        return 'sdk_gphone64_arm64 - 15 - API 35';
      },
    },
    host,
  );
  assert.ok(transport.dump);
  // Resolving the transport declares the dump; it does not yet pay for the probe.
  assert.equal(resolved, 0);
  await transport.dump({ maxEntries: 25, include: 'summary' }, new AbortController().signal);
  assert.equal(resolved, 1);
  const [dumpInput] = dumps.mock.calls[0] ?? [];
  assert.equal(
    (dumpInput as { metroDeviceIdentity?: string }).metroDeviceIdentity,
    'sdk_gphone64_arm64 - 15 - API 35',
  );
});

test('a resolver without a Metro binding is never called', async () => {
  metroReads.mockResolvedValue(undefined);
  let resolved = 0;
  await resolveReactNativeNetworkTransport(
    device('android'),
    {
      ...scope,
      resolveMetroDeviceIdentity: async () => {
        resolved += 1;
        return 'Device';
      },
    },
    host,
  );
  assert.equal(resolved, 0);
});
