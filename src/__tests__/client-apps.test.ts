import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import { createTransport } from './client-transport-fixture.ts';

test('apps.open resolves session device identifiers from open response', async () => {
  const setup = createTransport(async (req) => {
    if (req.command === 'open') {
      return {
        ok: true,
        data: {
          session: 'qa',
          sessionStateDir: '/tmp/agent-device/sessions/qa',
          runnerLogPath: '/tmp/agent-device/sessions/qa/runner.log',
          requestLogPath: '/tmp/agent-device/sessions/qa/requests/open.ndjson',
          eventLogPath: '/tmp/agent-device/sessions/qa/events.ndjson',
          appName: 'Settings',
          appBundleId: 'com.apple.Preferences',
          platform: 'ios',
          target: 'mobile',
          device: 'iPhone 16',
          id: 'SIM-001',
          kind: 'simulator',
          device_udid: 'SIM-001',
          ios_simulator_device_set: '/tmp/sim-set',
          warnings: ['Script publication was aborted by a second successful open.', 42],
          startup: {
            durationMs: 1234,
            measuredAt: '2026-03-13T10:00:00.000Z',
            method: 'open-command-roundtrip',
          },
        },
      };
    }
    throw new Error(`Unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.apps.open({
    app: 'Settings',
    platform: 'ios',
    relaunch: true,
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'open');
  assert.deepEqual(setup.calls[0]?.positionals, ['Settings']);
  assert.equal(result.identifiers.session, 'qa');
  assert.equal(result.identifiers.deviceId, 'SIM-001');
  assert.equal(result.identifiers.udid, 'SIM-001');
  assert.equal(result.identifiers.appId, 'com.apple.Preferences');
  assert.equal(result.sessionStateDir, '/tmp/agent-device/sessions/qa');
  assert.equal(result.runnerLogPath, '/tmp/agent-device/sessions/qa/runner.log');
  assert.equal(result.requestLogPath, '/tmp/agent-device/sessions/qa/requests/open.ndjson');
  assert.equal(result.eventLogPath, '/tmp/agent-device/sessions/qa/events.ndjson');
  assert.equal(result.device?.name, 'iPhone 16');
  assert.equal(result.device?.ios?.simulatorSetPath, '/tmp/sim-set');
  assert.deepEqual(result.warnings, [
    'Script publication was aborted by a second successful open.',
  ]);
});

test('apps.open reports an answered launch confirmation only when the daemon answered one', async () => {
  let launchConfirmation: unknown = 'accepted';
  const setup = createTransport(async (req) => {
    if (req.command === 'open') {
      return {
        ok: true,
        data: { session: 'qa', appBundleId: 'com.example.app', launchConfirmation },
      };
    }
    throw new Error(`Unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const answered = await client.apps.open({ app: 'com.example.app', platform: 'ios' });
  launchConfirmation = undefined;
  const unanswered = await client.apps.open({ app: 'com.example.app', platform: 'ios' });

  assert.equal(answered.launchConfirmation, 'accepted');
  assert.equal('launchConfirmation' in unanswered, false);
});

test('apps.open preserves the full initialSnapshotError shape through client normalization', async () => {
  // open --foreground: open succeeded, composed snapshot did not. The public
  // client result must carry the FULL daemon error — dropping the boundary
  // normalization (or truncating to code+message) must fail here.
  const initialSnapshotError = {
    code: 'COMMAND_FAILED',
    message: 'capture failed',
    hint: 'Run: agent-device snapshot -i',
    details: { reason: 'runner_capture_failed' },
    diagnosticId: 'ms-diag-1234',
    logPath: '/tmp/agent-device/sessions/qa/requests/snap.ndjson',
    retriable: true,
  };
  const setup = createTransport(async (req) => {
    if (req.command === 'open') {
      return {
        ok: true,
        data: {
          session: 'qa',
          appName: 'Settings',
          appBundleId: 'com.apple.Preferences',
          platform: 'ios',
          target: 'mobile',
          device: 'iPhone 16',
          id: 'SIM-001',
          kind: 'simulator',
          device_udid: 'SIM-001',
          warnings: ['The session is open, but the initial interactive snapshot failed.'],
          initialSnapshotError,
        },
      };
    }
    throw new Error(`Unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.apps.open({ app: 'Settings', platform: 'ios', foreground: true });

  assert.deepEqual(result.initialSnapshotError, initialSnapshotError);
  assert.equal(result.snapshot, undefined);
});

test('apps.open drops a malformed initialSnapshotError instead of projecting garbage', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      session: 'qa',
      appName: 'Settings',
      appBundleId: 'com.apple.Preferences',
      platform: 'ios',
      target: 'mobile',
      device: 'iPhone 16',
      id: 'SIM-001',
      kind: 'simulator',
      device_udid: 'SIM-001',
      initialSnapshotError: { code: 'COMMAND_FAILED' },
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.apps.open({ app: 'Settings', platform: 'ios' });

  assert.equal(result.initialSnapshotError, undefined);
});

test('apps.open forwards explicit runtime hints through the daemon request', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      session: 'qa',
      appName: 'Demo',
      appBundleId: 'com.example.demo',
      runtime: {
        platform: 'ios',
        metroHost: '127.0.0.1',
        metroPort: 8081,
      },
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.apps.open({
    app: 'Demo',
    platform: 'ios',
    runtime: {
      metroHost: '127.0.0.1',
      metroPort: 8081,
    },
  });

  assert.equal(setup.calls.length, 1);
  assert.deepEqual(setup.calls[0]?.runtime, {
    metroHost: '127.0.0.1',
    metroPort: 8081,
  });
  assert.deepEqual(result.runtime, {
    platform: 'ios',
    metroHost: '127.0.0.1',
    metroPort: 8081,
    bundleUrl: undefined,
    launchUrl: undefined,
  });
});

test('apps.installFromSource forwards source payload and normalizes launch identity', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      packageName: 'com.example.demo',
      appName: 'Demo',
      launchTarget: 'com.example.demo',
      installablePath: '/tmp/materialized/installable/demo.apk',
      archivePath: '/tmp/materialized/archive/demo.zip',
      materializationId: 'materialized-123',
      materializationExpiresAt: '2026-03-13T12:00:00.000Z',
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.apps.installFromSource({
    platform: 'android',
    retainPaths: true,
    retentionMs: 60_000,
    source: {
      kind: 'url',
      url: 'https://example.com/demo.apk',
      headers: { authorization: 'Bearer token' },
    },
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'install_source');
  assert.deepEqual(setup.calls[0]?.meta?.installSource, {
    kind: 'url',
    url: 'https://example.com/demo.apk',
    headers: { authorization: 'Bearer token' },
  });
  assert.equal(setup.calls[0]?.meta?.retainMaterializedPaths, true);
  assert.equal(setup.calls[0]?.meta?.materializedPathRetentionMs, 60_000);
  assert.deepEqual(result, {
    appName: 'Demo',
    appId: 'com.example.demo',
    bundleId: undefined,
    packageName: 'com.example.demo',
    launchTarget: 'com.example.demo',
    installablePath: '/tmp/materialized/installable/demo.apk',
    archivePath: '/tmp/materialized/archive/demo.zip',
    materializationId: 'materialized-123',
    materializationExpiresAt: '2026-03-13T12:00:00.000Z',
    identifiers: {
      session: 'qa',
      appId: 'com.example.demo',
      appBundleId: undefined,
      package: 'com.example.demo',
    },
  });
});

test('apps.installFromSource derives Android launchTarget from packageName when daemon omits it', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      packageName: 'com.example.package-name-only',
      appName: 'PackageNameOnly',
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.apps.installFromSource({
    platform: 'android',
    source: {
      kind: 'url',
      url: 'https://example.com/package-name-only.apk',
      headers: {},
    },
  });

  assert.deepEqual(result, {
    appName: 'PackageNameOnly',
    appId: 'com.example.package-name-only',
    bundleId: undefined,
    packageName: 'com.example.package-name-only',
    launchTarget: 'com.example.package-name-only',
    installablePath: undefined,
    archivePath: undefined,
    materializationId: undefined,
    materializationExpiresAt: undefined,
    identifiers: {
      session: 'qa',
      appId: 'com.example.package-name-only',
      appBundleId: undefined,
      package: 'com.example.package-name-only',
    },
  });
});

test('apps.installFromSource forwards GitHub Actions artifact sources unchanged', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      packageName: 'com.example.ci',
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.apps.installFromSource({
    platform: 'android',
    source: {
      kind: 'github-actions-artifact',
      owner: 'acme',
      repo: 'mobile',
      artifactId: 1234567890,
    },
  });

  assert.equal(setup.calls.length, 1);
  assert.deepEqual(setup.calls[0]?.meta?.installSource, {
    kind: 'github-actions-artifact',
    owner: 'acme',
    repo: 'mobile',
    artifactId: 1234567890,
  });
});
