import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ClickCommandResponseData,
  FillCommandResponseData,
  FindCommandResponseData,
  LongPressCommandResponseData,
  PressCommandResponseData,
} from '../contracts/interaction.ts';
import {
  createAgentDeviceClient,
  type AgentDeviceClient,
  type AgentDeviceClientConfig,
  type DiffSnapshotCommandResult,
  type DoctorCommandResult,
  type PrepareCommandResult,
  type PushCommandResult,
  type RecordingCommandResult,
  type ReplayCommandResult,
  type ReplaySuiteResult,
  type TraceCommandResult,
  type TriggerAppEventCommandResult,
  type WaitCommandResult,
} from '../agent-device-client.ts';
import { runCommand } from '../commands/command-surface.ts';
import type { CommandResult } from '../core/command-descriptor/command-result.ts';
import type { DaemonRequest, DaemonResponse, DaemonResponseData } from '../kernel/contracts.ts';
import { AppError } from '../kernel/errors.ts';

// Isolated so open/close metro-session-hint file writes never touch the real state dir.
const TEST_STATE_DIR = mkdtempSync(path.join(os.tmpdir(), 'agent-device-client-test-'));

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const closedProjectionResponses: Record<string, DaemonResponseData> = {
  wait: { waitedMs: 25, text: 'Ready' },
  prepare: {
    action: 'ios-runner',
    platform: 'ios',
    deviceId: 'SIM-001',
    deviceName: 'iPhone 16',
    kind: 'simulator',
    durationMs: 30,
    runner: { uptimeMs: 42 },
    cache: 'exact',
    artifact: 'valid',
    buildMs: 10,
    connectMs: 20,
    healthCheckMs: 10,
    xctestrunPath: '/tmp/AgentDevice.xctestrun',
    timing: {
      totalMs: 30,
      additiveParts: { buildMs: 10, connectAfterBuildMs: 10, healthCheckMs: 10 },
      containment: { connectMs: ['buildMs'], healthCheckMs: [] },
      note: 'Use additiveParts.',
    },
    message: 'Prepared Apple runner: iPhone 16',
  },
  push: {
    platform: 'android',
    package: 'com.example.demo',
    action: 'com.example.demo.TEST_PUSH',
    extrasCount: 1,
    message: 'Pushed notification to com.example.demo',
  },
  'trigger-app-event': {
    event: 'screenshot_taken',
    eventUrl: 'demo://agent-device/event?name=screenshot_taken',
    transport: 'deep-link',
    message: 'Triggered app event: screenshot_taken',
  },
};

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
    stateDir: TEST_STATE_DIR,
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

test('client exposes narrowed result types for closed daemon projections', async () => {
  const setup = createTransport(async (req) => closedProjectionResponse(req.command));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const waitResult = await client.command.wait({ durationMs: 25 });
  const prepareResult = await client.command.prepare({ action: 'ios-runner' });
  const pushResult = await client.apps.push({
    app: 'com.example.demo',
    payload: { extras: { source: 'test' } },
  });
  const triggerResult = await client.apps.triggerEvent({ event: 'screenshot_taken' });

  const waitType: Equal<typeof waitResult, WaitCommandResult> = true;
  const prepareType: Equal<typeof prepareResult, PrepareCommandResult> = true;
  const pushType: Equal<typeof pushResult, PushCommandResult> = true;
  const triggerType: Equal<typeof triggerResult, TriggerAppEventCommandResult> = true;
  const clientWaitType: Equal<
    Awaited<ReturnType<AgentDeviceClient['command']['wait']>>,
    CommandResult<'wait'>
  > = true;
  const doctorType: Equal<
    Awaited<ReturnType<AgentDeviceClient['command']['doctor']>>,
    DoctorCommandResult
  > = true;
  const diffType: Equal<
    Awaited<ReturnType<AgentDeviceClient['capture']['diff']>>,
    DiffSnapshotCommandResult
  > = true;
  const replayType: Equal<
    Awaited<ReturnType<AgentDeviceClient['replay']['run']>>,
    ReplayCommandResult
  > = true;
  const replayTestType: Equal<
    Awaited<ReturnType<AgentDeviceClient['replay']['test']>>,
    ReplaySuiteResult
  > = true;
  const recordType: Equal<
    Awaited<ReturnType<AgentDeviceClient['recording']['record']>>,
    RecordingCommandResult
  > = true;
  const traceType: Equal<
    Awaited<ReturnType<AgentDeviceClient['recording']['trace']>>,
    TraceCommandResult
  > = true;

  assert.deepEqual(
    [
      waitType,
      prepareType,
      pushType,
      triggerType,
      clientWaitType,
      doctorType,
      diffType,
      replayType,
      replayTestType,
      recordType,
      traceType,
    ],
    [true, true, true, true, true, true, true, true, true, true, true],
  );
  assert.deepEqual(waitResult, { waitedMs: 25, text: 'Ready' });
  assert.equal(prepareResult.timing.additiveParts.connectAfterBuildMs, 10);
  assert.equal(pushResult.platform, 'android');
  assert.equal(triggerResult.transport, 'deep-link');
});

test('deprecated client.command.rotate delegates to orientation and keeps the legacy action', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      action: 'orientation',
      orientation: 'landscape-left',
      message: 'Rotated to landscape-left',
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.command.rotate({ orientation: 'landscape-left' });

  // The wrapper sends the canonical wire command...
  assert.equal(setup.calls.at(-1)?.command, 'orientation');
  // ...and restores the shipped v0.18/v0.19 response contract for old consumers.
  assert.equal(result.action, 'rotate');
  assert.equal(result.orientation, 'landscape-left');
});

function closedProjectionResponse(command: string): DaemonResponse {
  const data = closedProjectionResponses[command];
  if (!data) throw new Error(`Unexpected command: ${command}`);
  return { ok: true, data };
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
  assert.deepEqual(result.warnings, [
    'Script publication was aborted by a second successful open.',
  ]);
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

test('client close surfaces the daemon savedScript path on both sessions.close and apps.close (#1258)', async () => {
  const savedScriptPath = '/tmp/agent-device/flows/login.healed.ad';
  const setup = createTransport(async () => ({
    ok: true,
    data: { session: 'qa', savedScript: savedScriptPath },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const sessionClose = await client.sessions.close({ saveScript: true });
  const appClose = await client.apps.close({ saveScript: true });

  // The committed artifact path round-trips so a Node client that requested
  // publication learns where the file landed.
  assert.equal(sessionClose.savedScript, savedScriptPath);
  assert.equal(appClose.savedScript, savedScriptPath);
});

test('client close omits savedScript when the daemon published nothing (#1258)', async () => {
  const setup = createTransport(async () => ({ ok: true, data: { session: 'qa' } }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const sessionClose = await client.sessions.close({});
  const appClose = await client.apps.close({});

  assert.equal(sessionClose.savedScript, undefined);
  assert.equal(appClose.savedScript, undefined);
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

test('interactions.pan projects one- and two-finger requests through typed gesture input', async () => {
  const setup = createTransport(async () => ({ ok: true, data: { message: 'Panned' } }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  await client.interactions.pan({ x: 100, y: 200, dx: 40, dy: -20 });
  await client.interactions.pan({
    x: 100,
    y: 200,
    dx: 40,
    dy: -20,
    pointerCount: 2,
    durationMs: 600,
  });

  assert.deepEqual(
    setup.calls.map(({ command, positionals, input }) => ({ command, positionals, input })),
    [
      {
        command: 'gesture',
        positionals: [],
        input: {
          kind: 'pan',
          origin: { x: 100, y: 200 },
          delta: { x: 40, y: -20 },
        },
      },
      {
        command: 'gesture',
        positionals: [],
        input: {
          kind: 'pan',
          origin: { x: 100, y: 200 },
          delta: { x: 40, y: -20 },
          pointerCount: 2,
          durationMs: 600,
        },
      },
    ],
  );
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

test('client capture.snapshot preserves refsGeneration from daemon responses (ADR 0014)', async () => {
  const setup = createTransport(async () => ({
    ok: true,
    data: {
      nodes: [{ ref: 'e1', index: 0, depth: 0, type: 'Button', label: 'Go' }],
      truncated: false,
      refsGeneration: 752890,
    },
  }));
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.capture.snapshot();

  // Node.js callers must retain the response-level generation to pin a plain ref
  // (`@e1~s752890`) before a mutation.
  assert.equal(result.refsGeneration, 752890);
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
      width: 402,
      height: 874,
      logicalWidth: 402,
      logicalHeight: 874,
      pixelDensity: 1,
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
    width: 402,
    height: 874,
    logicalWidth: 402,
    logicalHeight: 874,
    pixelDensity: 1,
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

test('capture.screenshot passes a digest (non-default level) payload through unnormalized', async () => {
  const digest: DaemonResponseData = {
    path: '/tmp/shot.png',
    overlayCount: 2,
    overlayRefs: [{ ref: 'e1', label: 'Login' }],
    artifacts: [{ field: 'path', artifactType: 'screenshot', artifactId: 'a1' }],
  };
  const setup = createTransport(async (req) => {
    assert.equal(req.command, 'screenshot');
    assert.equal(req.meta?.responseLevel, 'digest'); // the level reached the daemon
    return { ok: true, data: digest };
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.capture.screenshot({ responseLevel: 'digest' });

  // The digest SURVIVES the shipped client path: overlayCount, the leveled
  // overlayRefs ({ref,label}), and artifacts are not dropped, and the default
  // normalizer (which would add `identifiers` and strip those fields) is skipped.
  const asRecord = result as Record<string, unknown>;
  assert.deepEqual(asRecord, digest);
  assert.equal(asRecord.overlayCount, 2);
  assert.ok(!('identifiers' in asRecord));
});

test('capture.screenshot normalizes the default-level result (unchanged)', async () => {
  const setup = createTransport(async (req) => {
    assert.equal(req.command, 'screenshot');
    assert.equal(req.meta?.responseLevel, undefined);
    return {
      ok: true,
      data: {
        path: '/tmp/shot.png',
        width: 1206,
        height: 2622,
        logicalWidth: 402,
        logicalHeight: 874,
        pixelDensity: 3,
        overlayRefs: [{ ref: 'e1', label: 'Login', x: 0, y: 0, width: 10, height: 10 }],
      },
    };
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.capture.screenshot();

  assert.equal(result.path, '/tmp/shot.png');
  assert.equal(result.width, 1206);
  assert.equal(result.height, 2622);
  assert.equal(result.logicalWidth, 402);
  assert.equal(result.logicalHeight, 874);
  assert.equal(result.pixelDensity, 3);
  assert.deepEqual(result.identifiers, { session: 'qa' });
});

test('capture.snapshot passes a digest (non-default level) payload through unnormalized', async () => {
  const digest = {
    nodeCount: 3,
    refs: [{ ref: 'e1', label: 'Login' }],
    truncated: false,
  };
  const setup = createTransport(async (req) => {
    assert.equal(req.command, 'snapshot');
    assert.equal(req.meta?.responseLevel, 'digest'); // the level reached the daemon
    return { ok: true, data: digest };
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const result = await client.capture.snapshot({ responseLevel: 'digest' });

  // The digest SURVIVES the client path: nodeCount/refs are preserved and the
  // default normalizer (which expects `nodes` and would yield an empty snapshot
  // plus `identifiers`) is skipped.
  const asRecord = result as Record<string, unknown>;
  assert.deepEqual(asRecord, digest);
  assert.equal(asRecord.nodeCount, 3);
  assert.ok(!('identifiers' in asRecord));
});

test('interactions expose targetKind-discriminated public response data', async () => {
  const setup = createTransport(async (req) => {
    if (req.command === 'press') {
      return {
        ok: true,
        data: {
          targetKind: 'ref',
          ref: 'e5',
          x: 88,
          y: 99,
          message: 'Tapped @e5 (88, 99)',
        },
      };
    }
    if (req.command === 'click') {
      return {
        ok: true,
        data: {
          targetKind: 'point',
          x: 10,
          y: 20,
          button: 'secondary',
          message: 'Tapped (10, 20)',
        },
      };
    }
    if (req.command === 'fill') {
      return {
        ok: true,
        data: {
          targetKind: 'ref',
          ref: 'e5',
          x: 88,
          y: 99,
          text: 'hello',
          message: 'Filled 5 chars',
        },
      };
    }
    if (req.command === 'longpress') {
      return {
        ok: true,
        data: {
          targetKind: 'selector',
          selector: 'label=Foo',
          x: 30,
          y: 40,
          gesture: 'longpress',
          durationMs: 500,
          message: 'Long pressed label=Foo (30, 40)',
        },
      };
    }
    if (req.command === 'find') {
      return {
        ok: true,
        data: { ref: '@e5', refsGeneration: 42, text: 'Hello' },
      };
    }
    throw new Error(`unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const press = await client.interactions.press({ ref: '@e5' });
  const click = await client.interactions.click({ x: 10, y: 20, button: 'secondary' });
  const fill = await client.interactions.fill({ ref: '@e5', text: 'hello' });
  const longPress = await client.interactions.longPress({
    selector: 'label=Foo',
    durationMs: 500,
  });
  const find = await client.interactions.find({
    locator: 'label',
    query: 'Foo',
    action: 'getText',
  });

  const pressType: Equal<typeof press, PressCommandResponseData> = true;
  const clickType: Equal<typeof click, ClickCommandResponseData> = true;
  const fillType: Equal<typeof fill, FillCommandResponseData> = true;
  const longPressType: Equal<typeof longPress, LongPressCommandResponseData> = true;
  const findType: Equal<typeof find, FindCommandResponseData> = true;

  assert.equal(press.targetKind, 'ref');
  assert.equal(press.ref, 'e5');
  assert.equal(press.x, 88);
  assert.equal(press.y, 99);

  assert.equal(click.targetKind, 'point');
  assert.equal(click.x, 10);
  assert.equal(click.y, 20);
  assert.equal(click.button, 'secondary');

  assert.equal(fill.targetKind, 'ref');
  assert.equal(fill.ref, 'e5');
  assert.equal(fill.text, 'hello');

  assert.equal(longPress.targetKind, 'selector');
  assert.equal(longPress.selector, 'label=Foo');
  assert.equal(longPress.gesture, 'longpress');
  assert.equal(longPress.durationMs, 500);

  assert.equal(find.ref, '@e5');
  assert.equal(find.refsGeneration, 42);
  assert.equal(find.text, 'Hello');

  assert.deepEqual(
    [pressType, clickType, fillType, longPressType, findType],
    [true, true, true, true, true],
  );
});

test('interaction responses expose additive cost and direct-iOS Maestro fallback fields', async () => {
  const setup = createTransport(async (req) => {
    if (req.command === 'press') {
      return {
        ok: true,
        data: {
          targetKind: 'ref',
          ref: 'e5',
          cost: { wallClockMs: 123, runnerRoundTrips: 2, nodeCount: 5 },
        },
      };
    }
    if (req.command === 'click') {
      return {
        ok: true,
        data: {
          targetKind: 'selector',
          selector: 'id=hidden',
          maestroNonHittableCoordinateFallbackAllowed: true,
          maestroNonHittableCoordinateFallbackUsed: true,
          maestroFallbackReason: 'non-hittable-coordinate',
        },
      };
    }
    if (req.command === 'find') {
      return {
        ok: true,
        data: {
          ref: '@e5',
          refsGeneration: 42,
          text: 'Hello',
          cost: { wallClockMs: 45, runnerRoundTrips: 0 },
        },
      };
    }
    throw new Error(`unexpected command: ${req.command}`);
  });
  const client = createAgentDeviceClient(setup.config, { transport: setup.transport });

  const press = await client.interactions.press({ ref: '@e5', cost: true });
  const click = await client.interactions.click({ selector: 'id=hidden' });
  const find = await client.interactions.find({
    locator: 'label',
    query: 'Foo',
    action: 'getText',
    cost: true,
  });

  assert.equal(press.targetKind, 'ref');
  assert.equal(press.cost?.wallClockMs, 123);
  assert.equal(press.cost?.runnerRoundTrips, 2);
  assert.equal(press.cost?.nodeCount, 5);

  assert.equal(click.targetKind, 'selector');
  assert.equal(click.selector, 'id=hidden');
  assert.equal(click.maestroNonHittableCoordinateFallbackAllowed, true);
  assert.equal(click.maestroNonHittableCoordinateFallbackUsed, true);
  assert.equal(click.maestroFallbackReason, 'non-hittable-coordinate');

  assert.equal(find.ref, '@e5');
  assert.equal(find.cost?.wallClockMs, 45);
  assert.equal(find.cost?.runnerRoundTrips, 0);
});
