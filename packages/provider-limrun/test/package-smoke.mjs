import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

export const provider = 'limrun';
export const primaryExport = {
  types: './dist/agent-device.d.mts',
  import: './dist/agent-device.mjs',
};
export const additionalExports = { './package.json': './package.json' };
// The Limrun SDK is the plugin's own dependency, so a user can update it without a core release.
export const dependencies = { '@limrun/api': '^0.69.1' };
export const args = ['--platform', 'android'];
export const fetchRedirects = ['https://api.limrun.com'];

export function environment() {
  return { LIMRUN_API_KEY: 'lim_fixture_key' };
}

export function respond(url, rejectCredentials) {
  const pathname = new URL(url, 'http://fixture').pathname;
  if (pathname !== '/v1/android_instances') return { status: 404, body: { error: 'not-found' } };
  if (rejectCredentials) return { status: 401, body: { error: 'unauthorized' } };
  return { body: [] };
}

export async function verifyPacked({ core, contracts, plugin }) {
  const limrun = plugin.default().contributes[0];
  assert.equal(limrun.kind, 'provider');
  assert.equal(limrun.provider, provider);
  assert.deepEqual(limrun.credentials.byBackend['android-instance'], [
    'LIMRUN_API_KEY',
    'LIMRUN_REGION',
    'LIM_ANDROID_INSTANCE_URL',
    'LIM_ANDROID_INSTANCE_TOKEN',
    'LIM_ANDROID_INSTANCE_ADB_URL',
  ]);
  assert.equal(limrun.connection.capabilities.leaseKind, 'direct-device-provider');
  assert.equal(limrun.connection.capabilities.supportsDeferredAppSelection, true);
  assert.equal(limrun.connection.capabilities.supportsDirectPortReverse, true);

  const host = (env) => ({
    env,
    options: {},
    clientVersion: '0.22.0',
    createError: (code, message, details) => new core.AppError(code, message, details),
    runHostCommand: async () => {
      throw new Error('Limrun runs no host command to set up');
    },
  });
  const capture = async (run) => {
    try {
      await run();
    } catch (error) {
      // The plugin bundles its own copy of the error class; the host recognizes it by brand.
      assert.ok(error instanceof core.AppError);
      return contracts.normalizeError(error);
    }
    assert.fail('Expected a Limrun failure');
  };
  const missingCredentials = await capture(() => limrun.setup(host({})));
  assert.equal(missingCredentials.code, 'INVALID_ARGS');
  assert.equal(missingCredentials.details.reason, 'missing_provider_credentials');
  assert.ok(missingCredentials.hint);

  // A host that supplies no device capabilities is refused before any instance is reached.
  const missingCapabilities = await capture(() =>
    limrun.setup(host({ LIMRUN_API_KEY: 'lim_fixture_key' })),
  );
  assert.equal(missingCapabilities.code, 'UNSUPPORTED_OPERATION');
  assert.equal(missingCapabilities.details.reason, 'provider_host_capability_missing');

  const refusedDevice = await capture(() =>
    limrun.connection.resolve({
      flags: { platform: 'android', device: 'Pixel 9' },
      stateDir: '/state',
      cwd: '/',
      env: { LIMRUN_API_KEY: 'lim_fixture_key' },
      host: host({ LIMRUN_API_KEY: 'lim_fixture_key' }),
    }),
  );
  assert.equal(refusedDevice.code, 'INVALID_ARGS');
}

export async function verifyTypes({ consumer, run, root }) {
  fs.writeFileSync(
    path.join(consumer, 'consumer.mts'),
    `
import { startAgentDevice } from 'agent-device';
import type { ProviderAgentDevicePlugin } from 'agent-device/plugins';
import limrun from '@agent-device/limrun/agent-device';
const plugin: ProviderAgentDevicePlugin = limrun();
const runtime = await startAgentDevice({ stateDir: './state', plugins: [plugin] });
await runtime.close();
`,
  );
  await run(
    process.execPath,
    [
      path.join(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      '--typeRoots',
      path.join(root, 'node_modules/@types'),
      'consumer.mts',
    ],
    consumer,
  );
}
