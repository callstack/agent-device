import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/exec.ts', () => ({
  runCmdDetached: vi.fn(),
}));

vi.mock('../utils/process-identity.ts', () => ({
  isProcessAlive: vi.fn(),
  readProcessCommand: vi.fn(),
  readProcessStartTime: vi.fn(),
  waitForProcessExit: vi.fn(),
}));

import { runCmdDetached } from '../utils/exec.ts';
import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
  waitForProcessExit,
} from '../utils/process-identity.ts';
import { ensureMetroCompanion, stopMetroCompanion } from '../metro/client-metro-companion.ts';
import { ensureReactDevtoolsCompanion } from '../client-react-devtools-companion.ts';

const TEST_BRIDGE_SCOPE = {
  tenantId: 'tenant-1',
  runId: 'run-1',
  leaseId: 'lease-1',
};

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function assertCompanionSpawnTarget(): void {
  const firstCall = vi.mocked(runCmdDetached).mock.calls[0];
  assert.ok(firstCall, 'expected runCmdDetached to be called');
  assert.equal(firstCall[0], process.execPath);
  assert.ok(
    firstCall[1].some((arg) => arg.includes('src/companion-tunnel.ts')),
    `expected companion entry path in ${JSON.stringify(firstCall[1])}`,
  );
  assert.equal(firstCall[1].at(-1), '--agent-device-run-metro-companion');
}

function assertCompanionRunArg(callIndex: number, runArg: string): void {
  const call = vi.mocked(runCmdDetached).mock.calls[callIndex];
  assert.ok(call, `expected runCmdDetached call ${callIndex}`);
  assert.equal(call[1].at(-1), runArg);
}

test('companion ownership is profile-scoped and consumer-counted', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-metro-companion-state-'));
  try {
    vi.mocked(runCmdDetached).mockReturnValueOnce(111).mockReturnValueOnce(222);
    vi.mocked(isProcessAlive).mockReturnValue(true);
    vi.mocked(readProcessStartTime).mockImplementation((pid) =>
      pid === 111 ? 'start-111' : 'start-222',
    );
    vi.mocked(readProcessCommand).mockImplementation(
      () => `${process.execPath} src/companion-tunnel.ts --agent-device-run-metro-companion`,
    );
    vi.mocked(waitForProcessExit).mockResolvedValue(true);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const stagingFirst = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://staging',
      profileKey: '/tmp/staging.json',
      consumerKey: 'session-a',
    });
    const stagingSecond = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://staging',
      profileKey: '/tmp/staging.json',
      consumerKey: 'session-b',
    });
    const prod = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://prod',
      profileKey: '/tmp/prod.json',
      consumerKey: 'session-prod',
    });

    assert.equal(stagingFirst.spawned, true);
    assert.equal(stagingSecond.spawned, false);
    assert.notEqual(stagingFirst.statePath, prod.statePath);
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 2);
    assertCompanionSpawnTarget();
    assert.equal(fs.existsSync(stagingFirst.logPath), true);
    assert.equal(fs.existsSync(prod.logPath), true);

    const stagingState = JSON.parse(fs.readFileSync(stagingFirst.statePath, 'utf8')) as {
      consumers: string[];
    };
    assert.deepEqual(stagingState.consumers.sort(), ['session-a', 'session-b']);

    const partialStop = await stopMetroCompanion({
      projectRoot,
      profileKey: '/tmp/staging.json',
      consumerKey: 'session-a',
    });
    assert.equal(partialStop.stopped, false);
    assert.equal(killSpy.mock.calls.length, 0);

    const remainingState = JSON.parse(fs.readFileSync(stagingFirst.statePath, 'utf8')) as {
      consumers: string[];
    };
    assert.deepEqual(remainingState.consumers, ['session-b']);

    const finalStop = await stopMetroCompanion({
      projectRoot,
      profileKey: '/tmp/staging.json',
      consumerKey: 'session-b',
    });
    assert.equal(finalStop.stopped, true);
    assert.equal(killSpy.mock.calls.length, 1);
    assert.deepEqual(killSpy.mock.calls[0], [111, 'SIGTERM']);
    assert.equal(fs.existsSync(stagingFirst.statePath), false);
    assert.equal(fs.existsSync(stagingFirst.logPath), false);

    const prodStop = await stopMetroCompanion({
      projectRoot,
      profileKey: '/tmp/prod.json',
      consumerKey: 'session-prod',
    });
    assert.equal(prodStop.stopped, true);
    assert.equal(killSpy.mock.calls.length, 2);
    assert.deepEqual(killSpy.mock.calls[1], [222, 'SIGTERM']);
    assert.equal(fs.existsSync(prod.statePath), false);
    assert.equal(fs.existsSync(prod.logPath), false);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('launchUrl changes force a companion respawn for the same profile', async () => {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-metro-companion-launch-'),
  );
  try {
    vi.mocked(runCmdDetached).mockReturnValueOnce(333).mockReturnValueOnce(444);
    vi.mocked(isProcessAlive).mockReturnValue(true);
    vi.mocked(readProcessStartTime).mockImplementation((pid) =>
      pid === 333 ? 'start-333' : 'start-444',
    );
    vi.mocked(readProcessCommand).mockImplementation(
      () => `${process.execPath} src/companion-tunnel.ts --agent-device-run-metro-companion`,
    );
    vi.mocked(waitForProcessExit).mockResolvedValue(true);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const first = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://first',
      profileKey: '/tmp/profile.json',
      consumerKey: 'session-a',
    });
    const second = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://second',
      profileKey: '/tmp/profile.json',
      consumerKey: 'session-a',
    });

    assert.equal(first.spawned, true);
    assert.equal(second.spawned, true);
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 2);
    assert.equal(killSpy.mock.calls.length, 1);
    assertCompanionSpawnTarget();
    assert.deepEqual(killSpy.mock.calls[0], [333, 'SIGTERM']);

    const state = JSON.parse(fs.readFileSync(second.statePath, 'utf8')) as {
      launchUrl?: string;
    };
    assert.equal(state.launchUrl, 'myapp://second');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('metro and React DevTools companions use distinct profile state paths', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-companion-paths-'));
  try {
    vi.mocked(runCmdDetached).mockReturnValueOnce(777).mockReturnValueOnce(888);
    vi.mocked(readProcessStartTime).mockImplementation((pid) =>
      pid === 777 ? 'start-777' : 'start-888',
    );
    vi.mocked(readProcessCommand).mockImplementation((pid) =>
      pid === 888
        ? `${process.execPath} src/companion-tunnel.ts --agent-device-run-react-devtools-companion`
        : `${process.execPath} src/companion-tunnel.ts --agent-device-run-metro-companion`,
    );

    const profileKey = '/tmp/shared-remote.json';
    const metro = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://open',
      profileKey,
      consumerKey: 'session-a',
    });
    const reactDevtools = await ensureReactDevtoolsCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      bridgeScope: TEST_BRIDGE_SCOPE,
      session: 'session-a',
      profileKey,
      consumerKey: 'session-a',
    });

    assert.notEqual(metro.statePath, reactDevtools.statePath);
    assert.notEqual(metro.logPath, reactDevtools.logPath);
    assert.match(metro.statePath, /metro-companion[/\\]metro-companion-[a-f0-9]+\.json$/);
    assert.match(
      reactDevtools.statePath,
      /react-devtools-companion[/\\]react-devtools-companion-[a-f0-9]+\.json$/,
    );
    assertCompanionRunArg(0, '--agent-device-run-metro-companion');
    assertCompanionRunArg(1, '--agent-device-run-react-devtools-companion');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('spawned companion uses neutral env names', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-companion-env-'));
  try {
    vi.mocked(runCmdDetached).mockReturnValueOnce(999);
    vi.mocked(readProcessStartTime).mockReturnValue('start-999');
    vi.mocked(readProcessCommand).mockReturnValue(
      `${process.execPath} src/companion-tunnel.ts --agent-device-run-metro-companion`,
    );

    await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      launchUrl: 'myapp://open',
      env: {},
    });

    const env = vi.mocked(runCmdDetached).mock.calls[0]?.[2]?.env;
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_SERVER_BASE_URL, 'https://bridge.example.test');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_BEARER_TOKEN, 'token');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_LOCAL_BASE_URL, 'http://127.0.0.1:8081');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_LAUNCH_URL, 'myapp://open');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_REGISTER_PATH, '/api/metro/companion/register');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_TENANT_ID, 'tenant-1');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_RUN_ID, 'run-1');
    assert.equal(env?.AGENT_DEVICE_COMPANION_TUNNEL_SCOPE_LEASE_ID, 'lease-1');
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('state sentinel exists before spawning companion worker', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-companion-sentinel-'));
  try {
    vi.mocked(runCmdDetached).mockImplementationOnce((_, __, options) => {
      const statePath = options?.env?.AGENT_DEVICE_COMPANION_TUNNEL_STATE_PATH;
      if (typeof statePath !== 'string') {
        throw new Error('expected companion state path env');
      }
      assert.equal(fs.existsSync(statePath), true);
      assert.equal(fs.readFileSync(statePath, 'utf8'), '');
      return 1001;
    });
    vi.mocked(readProcessStartTime).mockReturnValue('start-1001');
    vi.mocked(readProcessCommand).mockReturnValue(
      `${process.execPath} src/companion-tunnel.ts --agent-device-run-metro-companion`,
    );

    const spawned = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      consumerKey: 'session-a',
    });

    const state = JSON.parse(fs.readFileSync(spawned.statePath, 'utf8')) as {
      pid?: number;
      consumers?: string[];
    };
    assert.equal(state.pid, 1001);
    assert.deepEqual(state.consumers, ['session-a']);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test('legacy state without bridge scope is stopped before respawn', async () => {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-metro-companion-legacy-'),
  );
  const statePath = path.join(projectRoot, '.agent-device', 'metro-companion.json');
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        pid: 555,
        startTime: 'start-555',
        command: `${process.execPath} src/companion-tunnel.ts --agent-device-run-metro-companion`,
        serverBaseUrl: 'https://bridge.example.test',
        localBaseUrl: 'http://127.0.0.1:8081',
        tokenHash: 'legacy-token-hash',
        consumers: ['session-a'],
      })}\n`,
    );

    vi.mocked(runCmdDetached).mockReturnValueOnce(666);
    vi.mocked(isProcessAlive).mockReturnValue(true);
    vi.mocked(readProcessStartTime).mockReturnValue('start-555');
    vi.mocked(readProcessCommand).mockReturnValue(
      `${process.execPath} src/companion-tunnel.ts --agent-device-run-metro-companion`,
    );
    vi.mocked(waitForProcessExit).mockResolvedValue(true);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const spawned = await ensureMetroCompanion({
      projectRoot,
      serverBaseUrl: 'https://bridge.example.test',
      bearerToken: 'token',
      localBaseUrl: 'http://127.0.0.1:8081',
      bridgeScope: TEST_BRIDGE_SCOPE,
      consumerKey: 'session-a',
    });

    assert.equal(spawned.spawned, true);
    assert.equal(spawned.pid, 666);
    assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 1);
    assert.deepEqual(killSpy.mock.calls[0], [555, 'SIGTERM']);
    const state = JSON.parse(fs.readFileSync(spawned.statePath, 'utf8')) as {
      bridgeScope?: unknown;
    };
    assert.deepEqual(state.bridgeScope, TEST_BRIDGE_SCOPE);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
