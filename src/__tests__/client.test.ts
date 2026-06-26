import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createAgentDeviceClient, type AgentDeviceClientConfig } from '../client.ts';
import { runCommand } from '../commands/command-surface.ts';
import type { DaemonRequest, DaemonResponse } from '../contracts.ts';
import { AppError } from '../utils/errors.ts';

function createTransport(
  handler: (req: Omit<DaemonRequest, 'token'>) => Promise<DaemonResponse> | DaemonResponse,
): {
  calls: Array<Omit<DaemonRequest, 'token'>>;
  config: AgentDeviceClientConfig;
  transport: (req: Omit<DaemonRequest, 'token'>) => Promise<DaemonResponse>;
} {
  const calls: Array<Omit<DaemonRequest, 'token'>> = [];
  const config: AgentDeviceClientConfig = {
    session: 'qa',
    cwd: '/tmp/agent-device',
    debug: true,
    daemonBaseUrl: 'http://daemon.example.test',
    daemonAuthToken: 'secret',
    daemonTransport: 'http',
    tenant: 'acme',
    sessionIsolation: 'tenant',
    runId: 'run-123',
    leaseId: 'lease-123',
  };
  return {
    calls,
    config,
    transport: async (req) => {
      calls.push(req);
      return await handler(req);
    },
  };
}

test('apps.open resolves session device identifiers from open response', async () => {
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
          ios_simulator_device_set: '/tmp/sim-set',
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
    deviceHub: true,
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'open');
  assert.deepEqual(setup.calls[0]?.positionals, ['Settings']);
  assert.equal(setup.calls[0]?.flags?.deviceHub, true);
  assert.equal(result.identifiers.session, 'qa');
  assert.equal(result.identifiers.deviceId, 'SIM-001');
  assert.equal(result.identifiers.udid, 'SIM-001');
  assert.equal(result.identifiers.appId, 'com.apple.Preferences');
  assert.equal(result.device?.name, 'iPhone 16');
  assert.equal(result.device?.ios?.simulatorSetPath, '/tmp/sim-set');
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

test('client close normalizes target shutdown results', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data:
      setup.calls.length === 1
        ? {
            shutdown: {
              success: false,
              exitCode: -1,
              stdout: '',
              stderr: 'simctl shutdown failed',
              error: {
                code: 'COMMAND_FAILED',
                message: 'simctl shutdown failed',
                details: { retryable: false },
              },
            },
          }
        : {
            shutdown: { success: true },
          },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const sessionClose = await client.sessions.close({ shutdown: true });
  const appClose = await client.apps.close({ shutdown: true });

  assert.deepEqual(sessionClose.shutdown, {
    success: false,
    exitCode: -1,
    stdout: '',
    stderr: 'simctl shutdown failed',
    error: {
      code: 'COMMAND_FAILED',
      message: 'simctl shutdown failed',
      details: { retryable: false },
    },
  });
  assert.equal(appClose.shutdown, undefined);
});

test('observability.perf projects structured frame area to daemon positionals', async () => {
  const setup = createTransport(async (req) => {
    if (req.command === 'perf') {
      return {
        ok: true,
        data: {
          metrics: {
            fps: {
              available: false,
              reason: 'No frame data.',
            },
          },
        },
      };
    }
    throw new Error(`Unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.observability.perf({ area: 'frames', action: 'sample' });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'perf');
  assert.deepEqual(setup.calls[0]?.positionals, ['frames', 'sample']);
});

test('observability.perf projects memory snapshot options to daemon flags', async () => {
  const setup = createTransport(async (req) => {
    if (req.command === 'perf') {
      return {
        ok: true,
        data: {
          artifact: {
            available: true,
            kind: 'memgraph',
            path: '/tmp/app.memgraph',
          },
        },
      };
    }
    throw new Error(`Unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.observability.perf({
    area: 'memory',
    action: 'snapshot',
    kind: 'memgraph',
    out: 'app.memgraph',
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'perf');
  assert.deepEqual(setup.calls[0]?.positionals, ['memory', 'snapshot']);
  assert.equal(setup.calls[0]?.flags?.kind, 'memgraph');
  assert.equal(setup.calls[0]?.flags?.out, 'app.memgraph');
});

test('observability.perf projects structured Android native profile input to daemon positionals', async () => {
  const setup = createTransport(async (req) => {
    if (req.command === 'perf') {
      return {
        ok: true,
        data: {
          action: 'start',
          type: 'cpu-profile',
          kind: 'simpleperf',
          state: 'running',
        },
      };
    }
    throw new Error(`Unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.observability.perf({
    area: 'cpu',
    subject: 'profile',
    action: 'start',
    kind: 'simpleperf',
    out: 'cpu.perf.data',
  });

  assert.equal(setup.calls.length, 1);
  const call = setup.calls[0];
  assert.ok(call);
  assert.equal(call.command, 'perf');
  assert.deepEqual(call.positionals, [
    'cpu',
    'profile',
    'start',
    'simpleperf',
    '',
    'cpu.perf.data',
  ]);
  assert.ok(call.flags);
  assert.equal(call.flags.out, 'cpu.perf.data');
});

test('structured command input accepts target as deviceTarget alias when no UI target exists', async () => {
  const setup = createTransport(async (req) => {
    if (req.command === 'open') {
      return {
        ok: true,
        data: {
          session: 'qa',
          appName: 'Settings',
          appBundleId: 'com.apple.Preferences',
          platform: 'ios',
          target: 'tv',
          device: 'Apple TV',
          id: 'TV-001',
          kind: 'simulator',
        },
      };
    }
    throw new Error(`Unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await runCommand(client, 'open', { app: 'Settings', target: 'tv' });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'open');
  assert.deepEqual(setup.calls[0]?.positionals, ['Settings']);
  assert.equal(setup.calls[0]?.flags?.target, 'tv');
});

test('structured session command forwards common request options', async () => {
  const setup = createTransport(async (req) => {
    if (req.command === 'session_list') {
      return { ok: true, data: { sessions: [] } };
    }
    throw new Error(`Unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient({}, { transport: setup.transport });

  await runCommand(client, 'session', {
    action: 'list',
    daemonBaseUrl: 'http://remote.example.test',
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'session_list');
  assert.equal(setup.calls[0]?.flags?.daemonBaseUrl, 'http://remote.example.test');
});

test('structured interaction input keeps UI target separate from deviceTarget', async () => {
  const setup = createTransport(async (req) => {
    if (req.command === 'get' || req.command === 'longpress') {
      return {
        ok: true,
        data: { ok: true },
      };
    }
    throw new Error(`Unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await runCommand(client, 'get', {
    deviceTarget: 'mobile',
    format: 'text',
    target: { kind: 'ref', ref: '@e1' },
  });
  await runCommand(client, 'longpress', {
    deviceTarget: 'mobile',
    durationMs: 800,
    target: { kind: 'ref', ref: '@e2' },
  });

  assert.equal(setup.calls.length, 2);
  assert.equal(setup.calls[0]?.command, 'get');
  assert.deepEqual(setup.calls[0]?.positionals, ['text', '@e1']);
  assert.equal(setup.calls[0]?.flags?.target, 'mobile');
  assert.equal(setup.calls[1]?.command, 'longpress');
  assert.deepEqual(setup.calls[1]?.positionals, ['@e2', '800']);
  assert.equal(setup.calls[1]?.flags?.target, 'mobile');
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

test('interactions.rotateGesture rejects partial centers on the client side', async () => {
  const setup = createTransport(async () => {
    throw new Error('transport should not run for invalid input');
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await assert.rejects(
    () => client.interactions.rotateGesture({ degrees: 35, x: 200 }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'gesture rotate center requires both x and y',
  );
  assert.equal(setup.calls.length, 0);
});

// fallow-ignore-next-line complexity
test('replay.run serializes client-collected AD_VAR shell env into daemon request', async () => {
  const previousAppId = process.env.AD_VAR_APP_ID;
  const previousWaitMs = process.env.AD_VAR_WAIT_MS;
  const previousLegacy = process.env.AD_APP_ID;
  process.env.AD_VAR_APP_ID = 'com.example.debug';
  process.env.AD_VAR_WAIT_MS = '750';
  process.env.AD_APP_ID = 'legacy-prefix-ignored';
  try {
    const setup = createTransport(async () => ({ ok: true, data: {} }));
    const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

    await client.replay.run({
      path: './flows/login.ad',
      env: ['APP_ID=cli-override'],
    });

    assert.equal(setup.calls.length, 1);
    assert.equal(setup.calls[0]?.command, 'replay');
    assert.deepEqual(setup.calls[0]?.positionals, ['./flows/login.ad']);
    assert.deepEqual(setup.calls[0]?.flags?.replayEnv, ['APP_ID=cli-override']);
    assert.equal(setup.calls[0]?.flags?.replayBackend, undefined);
    const replayShellEnv = setup.calls[0]?.flags?.replayShellEnv as
      | Record<string, string>
      | undefined;
    assert.equal(replayShellEnv?.AD_VAR_APP_ID, 'com.example.debug');
    assert.equal(replayShellEnv?.AD_VAR_WAIT_MS, '750');
    assert.equal(Object.prototype.hasOwnProperty.call(replayShellEnv ?? {}, 'AD_APP_ID'), false);
  } finally {
    if (previousAppId === undefined) delete process.env.AD_VAR_APP_ID;
    else process.env.AD_VAR_APP_ID = previousAppId;
    if (previousWaitMs === undefined) delete process.env.AD_VAR_WAIT_MS;
    else process.env.AD_VAR_WAIT_MS = previousWaitMs;
    if (previousLegacy === undefined) delete process.env.AD_APP_ID;
    else process.env.AD_APP_ID = previousLegacy;
  }
});

test('replay.run keeps deprecated maestro option as backend alias', async () => {
  const setup = createTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.replay.run({
    path: './flows/login.yaml',
    maestro: true,
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'replay');
  assert.deepEqual(setup.calls[0]?.positionals, ['./flows/login.yaml']);
  assert.equal(setup.calls[0]?.flags?.replayBackend, 'maestro');
});

test('replay.run forwards timeout budget', async () => {
  const setup = createTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.replay.run({
    path: './flows/mod-lists.yaml',
    backend: 'maestro',
    timeoutMs: 240_000,
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'replay');
  assert.equal(setup.calls[0]?.flags?.timeoutMs, 240_000);
});

test('replay.test keeps backend alias for suite discovery', async () => {
  const setup = createTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.replay.test({
    paths: ['./flows/login.yaml'],
    backend: 'maestro',
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'test');
  assert.deepEqual(setup.calls[0]?.positionals, ['./flows/login.yaml']);
  assert.equal(setup.calls[0]?.flags?.replayBackend, 'maestro');
});

test('replay.test forwards recordVideo for per-attempt video recording', async () => {
  const setup = createTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.replay.test({
    paths: ['./flows/login.ad'],
    recordVideo: true,
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'test');
  assert.equal(setup.calls[0]?.flags?.recordVideo, true);
});

test('structured replay.test command forwards Maestro backend for suite discovery', async () => {
  const setup = createTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await runCommand(client, 'test', {
    paths: ['./e2e/maestro'],
    backend: 'maestro',
    platform: 'android',
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'test');
  assert.deepEqual(setup.calls[0]?.positionals, ['./e2e/maestro']);
  assert.equal(setup.calls[0]?.flags?.replayBackend, 'maestro');
  assert.equal(setup.calls[0]?.flags?.platform, 'android');
});

test('structured replay commands keep deprecated Maestro boolean alias', async () => {
  const setup = createTransport(async () => ({ ok: true, data: {} }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await runCommand(client, 'replay', {
    path: './flows/login.yaml',
    maestro: true,
  });
  await runCommand(client, 'test', {
    paths: ['./e2e/maestro'],
    maestro: true,
    platform: 'android',
  });

  assert.equal(setup.calls.length, 2);
  assert.equal(setup.calls[0]?.command, 'replay');
  assert.equal(setup.calls[0]?.flags?.replayBackend, 'maestro');
  assert.equal(setup.calls[1]?.command, 'test');
  assert.equal(setup.calls[1]?.flags?.replayBackend, 'maestro');
  assert.equal(setup.calls[1]?.flags?.platform, 'android');
});

test('client.command.wait prepares selector options and rejects invalid selectors', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {},
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.command.wait({
    selector: 'role=button[name="Continue"]',
    timeoutMs: 1_500,
    depth: 3,
    raw: true,
  });

  assert.equal(setup.calls.length, 1);
  assert.equal(setup.calls[0]?.command, 'wait');
  assert.deepEqual(setup.calls[0]?.positionals, ['role=button[name="Continue"]', '1500']);
  assert.equal(setup.calls[0]?.flags?.snapshotDepth, 3);
  assert.equal(setup.calls[0]?.flags?.snapshotRaw, true);

  await assert.rejects(
    async () => await client.command.wait({ selector: 'Continue' }),
    /Invalid wait selector: Continue/,
  );
  assert.equal(setup.calls.length, 1);
});

test('lease helpers forward scope through daemon-backed client methods', async () => {
  const setup = createTransport(async (req) => ({
    ok: true,
    data:
      req.command === 'lease_release'
        ? { released: true }
        : {
            lease: {
              leaseId: req.meta?.leaseId ?? 'lease-new',
              tenantId: req.meta?.tenantId,
              runId: req.meta?.runId,
              backend: req.meta?.leaseBackend,
            },
          },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const allocated = await client.leases.allocate({
    tenant: 'remote-tenant',
    runId: 'remote-run',
    leaseBackend: 'android-instance',
  });
  const released = await client.leases.release({
    tenant: 'remote-tenant',
    runId: 'remote-run',
    leaseId: allocated.leaseId,
  });

  assert.equal(setup.calls[0]?.command, 'lease_allocate');
  assert.equal(setup.calls[0]?.meta?.tenantId, 'remote-tenant');
  assert.equal(setup.calls[0]?.meta?.runId, 'remote-run');
  assert.equal(setup.calls[0]?.meta?.leaseBackend, 'android-instance');
  assert.equal(allocated.leaseId, 'lease-new');
  assert.equal(setup.calls[1]?.command, 'lease_release');
  assert.equal(setup.calls[1]?.meta?.leaseId, 'lease-new');
  assert.equal(released.released, true);
});

test('client capture.snapshot preserves visibility metadata from daemon responses', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      nodes: [],
      truncated: false,
      appBundleId: 'com.agentdevice.tester',
      visibility: {
        partial: true,
        visibleNodeCount: 64,
        totalNodeCount: 67,
        reasons: ['offscreen-nodes'],
      },
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.capture.snapshot();

  assert.deepEqual(result.visibility, {
    partial: true,
    visibleNodeCount: 64,
    totalNodeCount: 67,
    reasons: ['offscreen-nodes'],
  });
});

test('client capture.snapshot preserves snapshot quality annotation from daemon responses', async () => {
  const snapshotQuality = {
    state: 'recovered',
    backend: 'queries',
    reason: 'tree was sparse',
    reasonCode: 'sparse-tree',
    effectiveDepth: 2,
    collapsedLeafIndexes: [7],
  } as const;
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      nodes: [],
      truncated: false,
      snapshotQuality,
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.capture.snapshot();

  assert.deepEqual(result.snapshotQuality, snapshotQuality);
});

test('client capture.snapshot forwards force-full as snapshotForceFull flag', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: { nodes: [], truncated: false },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.capture.snapshot({ forceFull: true });

  assert.equal(setup.calls[0]?.command, 'snapshot');
  assert.equal(setup.calls[0]?.flags?.snapshotForceFull, true);
});

test('client capture.screenshot normalizes overlay refs from daemon response data', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      path: '/tmp/screenshot.png',
      overlayRefs: [
        {
          ref: '@e1',
          label: 'Continue',
          rect: { x: 10, y: 20, width: 30, height: 40 },
          overlayRect: { x: 12, y: 22, width: 34, height: 44 },
          center: { x: 25, y: 40 },
        },
        {
          ref: '@missing-center',
          rect: { x: 1, y: 2, width: 3, height: 4 },
          overlayRect: { x: 1, y: 2, width: 3, height: 4 },
        },
        {
          ref: '@array-rect',
          rect: [],
          overlayRect: { x: 1, y: 2, width: 3, height: 4 },
          center: { x: 2, y: 3 },
        },
        'not-an-overlay-ref',
      ],
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.capture.screenshot({ overlayRefs: true });

  assert.deepEqual(result, {
    path: '/tmp/screenshot.png',
    overlayRefs: [
      {
        ref: '@e1',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 30, height: 40 },
        overlayRect: { x: 12, y: 22, width: 34, height: 44 },
        center: { x: 25, y: 40 },
      },
    ],
    identifiers: { session: 'qa' },
  });
});

test('sessions.stateDir resolves locally without contacting the daemon', async () => {
  const setup = createTransport(async () => {
    throw new Error('unexpected daemon call');
  });
  const client = createAgentDeviceClient(
    { ...setup.config, stateDir: '/tmp/agent-device-client-state' },
    { transport: setup.transport },
  );

  const fromConfig = await client.sessions.stateDir();
  const fromOverride = await client.sessions.stateDir({
    stateDir: '/tmp/agent-device-override-state',
  });

  assert.equal(fromConfig, '/tmp/agent-device-client-state');
  assert.equal(fromOverride, '/tmp/agent-device-override-state');
  assert.equal(setup.calls.length, 0);
});
