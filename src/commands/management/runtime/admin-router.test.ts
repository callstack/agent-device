import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AgentDeviceBackend, BackendInstallSource } from '../../../backend.ts';
import type { ArtifactAdapter, FileInputRef } from '../../../io.ts';
import { createAgentDevice, localCommandPolicy } from '../../../runtime.ts';
import { restrictedCommandPolicy } from '../../../command-runtime/runtime-factory.ts';

const artifacts = {
  resolveInput: async (ref: FileInputRef) => ({
    path: ref.kind === 'path' ? ref.path : `/tmp/uploaded/${ref.id}.app`,
    cleanup: ref.kind === 'uploadedArtifact' ? async () => {} : undefined,
  }),
  reserveOutput: async (ref, options) => ({
    path: ref?.kind === 'path' ? ref.path : `/tmp/${options.field}${options.ext}`,
    visibility: options.visibility ?? 'client-visible',
    publish: async () => undefined,
  }),
  createTempFile: async (options) => ({
    path: `/tmp/${options.prefix}${options.ext}`,
    visibility: 'internal',
    cleanup: async () => {},
  }),
} satisfies ArtifactAdapter;

test('admin runtime commands call typed backend primitives', async () => {
  const calls: string[] = [];
  let installSource: BackendInstallSource | undefined;
  const device = createAgentDevice({
    backend: createAdminBackend(calls, (source) => {
      installSource = source;
    }),
    artifacts,
    policy: localCommandPolicy(),
  });

  const devices = await device.admin.devices({ filter: { platform: 'ios' } });
  assert.equal(devices.kind, 'adminDevices');
  assert.equal(devices.devices[0]?.id, 'SIM-1');

  const boot = await device.admin.boot({ target: { id: 'SIM-1' } });
  assert.equal(boot.kind, 'deviceBooted');

  const shutdown = await device.admin.shutdown({ target: { id: 'SIM-1' } });
  assert.equal(shutdown.kind, 'deviceShutdown');

  const installed = await device.admin.install({
    app: 'com.example.app',
    source: { kind: 'path', path: '/tmp/Example.app' },
  });
  assert.equal(installed.kind, 'appInstalled');
  assert.deepEqual(installSource, { kind: 'path', path: '/tmp/Example.app' });

  const reinstalled = await device.admin.reinstall({
    app: 'com.example.app',
    source: { kind: 'url', url: 'https://example.test/Example.app.zip' },
  });
  assert.equal(reinstalled.kind, 'appReinstalled');

  const installedFromSource = await device.admin.installFromSource({
    source: { kind: 'url', url: 'https://example.test/Other.app.zip' },
  });
  assert.equal(installedFromSource.kind, 'appInstalledFromSource');

  assert.deepEqual(calls, [
    'listDevices',
    'bootDevice',
    'shutdownDevice',
    'installApp',
    'reinstallApp',
    'installApp',
  ]);
});

test('admin install blocks local paths under restricted policy but accepts uploaded artifacts', async () => {
  let sourceSeen: BackendInstallSource | undefined;
  const device = createAgentDevice({
    backend: createAdminBackend([], (source) => {
      sourceSeen = source;
    }),
    artifacts,
    policy: restrictedCommandPolicy(),
  });

  await assert.rejects(
    () =>
      device.admin.install({
        app: 'com.example.app',
        source: { kind: 'path', path: '/tmp/Example.app' },
      }),
    /Local source paths are not allowed/,
  );

  await device.admin.install({
    app: 'com.example.app',
    source: { kind: 'uploadedArtifact', id: 'artifact-1' },
  });
  assert.deepEqual(sourceSeen, { kind: 'path', path: '/tmp/uploaded/artifact-1.app' });
});

test('admin install cleans materialized input when backend source resolution fails', async () => {
  let cleanupCalled = false;
  let installCalled = false;
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      resolveInstallSource: async () => {
        throw new Error('backend source resolution failed');
      },
      installApp: async () => {
        installCalled = true;
        return {};
      },
    },
    artifacts: {
      ...artifacts,
      resolveInput: async (ref: FileInputRef) => ({
        path: ref.kind === 'path' ? ref.path : `/tmp/uploaded/${ref.id}.app`,
        cleanup:
          ref.kind === 'uploadedArtifact'
            ? async () => {
                cleanupCalled = true;
              }
            : undefined,
      }),
    },
    policy: restrictedCommandPolicy(),
  });

  await assert.rejects(
    () =>
      device.admin.install({
        app: 'com.example.app',
        source: { kind: 'uploadedArtifact', id: 'artifact-1' },
      }),
    /backend source resolution failed/,
  );

  assert.equal(cleanupCalled, true);
  assert.equal(installCalled, false);
});

function createAdminBackend(
  calls: string[],
  onInstallSource?: (source: BackendInstallSource) => void,
): AgentDeviceBackend {
  return {
    platform: 'ios',
    listDevices: async () => {
      calls.push('listDevices');
      return [{ id: 'SIM-1', name: 'iPhone 16', platform: 'ios', kind: 'simulator' }];
    },
    bootDevice: async () => {
      calls.push('bootDevice');
    },
    shutdownDevice: async () => {
      calls.push('shutdownDevice');
    },
    installApp: async (_context, target) => {
      calls.push('installApp');
      onInstallSource?.(target.source);
      return { bundleId: target.app ?? 'com.example.app' };
    },
    reinstallApp: async (_context, target) => {
      calls.push('reinstallApp');
      onInstallSource?.(target.source);
      return { bundleId: target.app ?? 'com.example.app' };
    },
  };
}
