import { bindTestCommandHost, installFakeManagedAgentBrowser } from '@agent-device/test-kit';
import assert from 'node:assert/strict';
import * as hostFile from '@agent-device/host-kit/host-file';
import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from './__tests__/test-utils.ts';

const { runCmdMock, spawnMock, probe } = vi.hoisted(() => ({
  runCmdMock: vi.fn(),
  spawnMock: vi.fn(),
  probe: { unanswered: false, platform: undefined as NodeJS.Platform | undefined },
}));

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: runCmdMock,
  withoutCommandExecutorOverride: async <T>(fn: () => Promise<T>) => await fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnMock.mockImplementation(actual.spawn);
  return { ...actual, spawn: spawnMock };
});

const executablePathsMock = vi.hoisted(() => vi.fn());

const identitiesMock = vi.hoisted(() =>
  vi.fn(
    async (pids: Iterable<number>) =>
      new Map(
        [...pids].map((pid) => [
          pid,
          { startTime: `start-${pid}`, command: `command-${pid}`, zombie: false },
        ]),
      ),
  ),
);

vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return {
    ...actual,
    hostPlatform: () => probe.platform ?? actual.hostPlatform(),
    listHostProcesses: async (options: Parameters<typeof actual.listHostProcesses>[0]) =>
      await actual.listHostProcesses({ ...options, runCommand: runCmdMock }),
    readHostProcessIdentityObservationsAsync: async (pids: Iterable<number>) =>
      probe.unanswered
        ? new Map<number, { state: string; startTime: string }>()
        : await actual.readHostProcessIdentityObservationsAsync(pids),
    readProcessIdentities: identitiesMock,
    readProcessExecutablePaths: executablePathsMock,
  };
});

import {
  DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS,
  agentBrowserChromeLaunchMarker,
  appendAgentDeviceChromeArgs,
  cleanupManagedAgentBrowserOrphans,
  resolveAgentBrowserIdleTimeoutMs,
  summarizeAgentBrowserProcesses,
} from './agent-browser-lifecycle.ts';
import { agentBrowserFleetOf } from './agent-browser-fleet.ts';
import { managedInstallPaths } from './agent-browser-install-paths.ts';
import {
  managedWebBrowserProcessRecordIsLive,
  recordManagedAgentBrowserProcesses,
} from './agent-browser-process-record.ts';
import { getManagedAgentBrowserStatus } from './agent-browser-tool.ts';
import {
  createOwnedProcessRecordStore,
  reapOwnedProcessRecordsAtStartup,
} from '@agent-device/host-kit/process';

bindTestCommandHost();

const mockRunCmd = vi.mocked(runCmdMock);

beforeEach(() => {
  mockRunCmd.mockReset();
  identitiesMock.mockClear();
  executablePathsMock.mockReset();
  probe.unanswered = false;
  probe.platform = undefined;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('managed Chrome launch args include a stable agent-device ownership marker once', () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const marker = agentBrowserChromeLaunchMarker(status);

    assert.match(marker, /^--agent-device-managed-web=[a-f0-9]{16}$/);
    assert.equal(appendAgentDeviceChromeArgs(undefined, status), marker);
    assert.equal(appendAgentDeviceChromeArgs('--no-sandbox', status), `--no-sandbox,${marker}`);
    assert.equal(
      appendAgentDeviceChromeArgs(`--no-sandbox,${marker}`, status),
      `--no-sandbox,${marker}`,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('managed agent-browser idle timeout defaults to five minutes and respects overrides', () => {
  assert.equal(resolveAgentBrowserIdleTimeoutMs({}), DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS);
  assert.equal(
    resolveAgentBrowserIdleTimeoutMs({ AGENT_DEVICE_WEB_IDLE_TIMEOUT_MS: '1200' }),
    1200,
  );
  assert.equal(
    resolveAgentBrowserIdleTimeoutMs({
      AGENT_BROWSER_IDLE_TIMEOUT_MS: '900',
      AGENT_DEVICE_WEB_IDLE_TIMEOUT_MS: '1200',
    }),
    900,
  );
  assert.equal(
    resolveAgentBrowserIdleTimeoutMs({ AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' }),
    DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS,
  );
});

function matchChrome(
  processInfo: { pid: number; command: string },
  status: ReturnType<typeof getManagedAgentBrowserStatus>,
) {
  return summarizeAgentBrowserProcesses([processInfo], status).processes[0];
}

test('ownership detection accepts only Chrome-like processes with managed markers', () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const marker = agentBrowserChromeLaunchMarker(status);
    const managedChrome = path.join(
      status.homeDir,
      '.agent-browser',
      'browsers',
      'chrome-150',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    );

    const markerMatch = matchChrome(
      { pid: 11, command: `/Applications/Chromium.app/Contents/MacOS/Chromium ${marker}` },
      status,
    );
    const homeMatch = matchChrome({ pid: 12, command: `${managedChrome} --type=renderer` }, status);
    const userChrome = matchChrome(
      {
        pid: 13,
        command:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default',
      },
      status,
    );
    const broadRuntimeHome = matchChrome(
      { pid: 15, command: `${status.runtimeHomeDir}/profile-cache/chrome-helper` },
      status,
    );
    const markedNonBrowser = matchChrome({ pid: 14, command: `/bin/sh -c echo ${marker}` }, status);

    assert.equal(markerMatch?.reason, 'launch-marker');
    assert.equal(homeMatch?.reason, 'managed-browser-home');
    assert.equal(userChrome, undefined);
    assert.equal(broadRuntimeHome, undefined);
    assert.equal(markedNonBrowser, undefined);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cleanup skips reaping when the daemon reports open web sessions', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const result = await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
      env: process.env,
      openWebSessionNames: ['default-web'],
    });

    assert.equal(result.skipped?.reason, 'open-web-session');
    assert.deepEqual(result.skipped?.openWebSessionNames, ['default-web']);
    assert.equal(mockRunCmd.mock.calls.length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

function recordedBrowserStore(stateDir: string, pid = NEVER_A_PID) {
  return {
    read: () => [
      {
        scope: { kind: 'daemon' as const },
        path: path.join(stateDir, 'owned-processes.json'),
        status: 'decoded' as const,
        records: [
          {
            pid,
            startTime: `start-${pid}`,
            command: `command-${pid}`,
            purpose: 'verified-managed-web-browser',
          },
        ],
      },
    ],
    replace: vi.fn(),
    clear: vi.fn(),
  };
}

test('cleanup skips reaping while the browser fleet holds an opening session', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  const ownedProcessRecords = recordedBrowserStore(stateDir);
  agentBrowserFleetOf(ownedProcessRecords).openStarted('fleet-web');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const result = await cleanupManagedAgentBrowserOrphans(status, 'provider-startup', {
      env: process.env,
      ownedProcessRecords,
    });

    assert.equal(result.skipped?.reason, 'open-web-session');
    assert.deepEqual(result.skipped?.openWebSessionNames, ['fleet-web']);
    assert.equal(mockRunCmd.mock.calls.length, 0);
    expect(ownedProcessRecords.clear).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cleanup reaps when the only fleet session is the one whose open runs it', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  const ownedProcessRecords = recordedBrowserStore(stateDir);
  agentBrowserFleetOf(ownedProcessRecords).openStarted('fleet-web');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const result = await cleanupManagedAgentBrowserOrphans(status, 'provider-startup', {
      env: process.env,
      ownedProcessRecords,
      startingSession: 'fleet-web',
    });

    assert.equal(result.skipped, undefined);
    assert.deepEqual(result.pids, [NEVER_A_PID]);
    expect(ownedProcessRecords.clear).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cleanup evicts a launched session whose recorded browser exited, then reaps', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  const ownedProcessRecords = recordedBrowserStore(stateDir);
  const fleet = agentBrowserFleetOf(ownedProcessRecords);
  fleet.openStarted('fleet-web');
  fleet.openSettled('fleet-web', true);
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const result = await cleanupManagedAgentBrowserOrphans(status, 'provider-startup', {
      env: process.env,
      ownedProcessRecords,
    });

    assert.equal(result.skipped, undefined);
    assert.deepEqual(result.pids, [NEVER_A_PID]);
    assert.deepEqual(fleet.sessions(), []);
    expect(ownedProcessRecords.clear).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cleanup keeps a launched session when the process probe does not answer', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  const ownedProcessRecords = recordedBrowserStore(stateDir, process.pid);
  const fleet = agentBrowserFleetOf(ownedProcessRecords);
  fleet.openStarted('fleet-web');
  fleet.openSettled('fleet-web', true);
  probe.unanswered = true;
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const result = await cleanupManagedAgentBrowserOrphans(status, 'provider-startup', {
      env: process.env,
      ownedProcessRecords,
    });

    assert.equal(result.skipped?.reason, 'open-web-session');
    assert.deepEqual(result.skipped?.openWebSessionNames, ['fleet-web']);
    assert.deepEqual(fleet.sessions(), ['fleet-web']);
    expect(ownedProcessRecords.clear).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cleanup skips reaping when managed browser socket activity is recent', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  const originalIdleTimeout = process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '60000';
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    fs.mkdirSync(status.socketDir, { recursive: true });
    fs.writeFileSync(path.join(status.socketDir, 'agent-browser.sock'), '');

    const result = await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
      env: process.env,
    });

    assert.equal(result.skipped?.reason, 'recent-browser-activity');
    assert.equal(mockRunCmd.mock.calls.length, 0);
  } finally {
    if (originalIdleTimeout === undefined) {
      delete process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
    } else {
      process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = originalIdleTimeout;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cleanup does not treat the shared socket directory mtime as browser activity', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  const originalIdleTimeout = process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '60000';
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    fs.mkdirSync(status.socketDir, { recursive: true });
    mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    const result = await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
      env: process.env,
    });

    assert.equal(result.skipped, undefined);
    assert.equal(mockRunCmd.mock.calls.length, 0);
  } finally {
    if (originalIdleTimeout === undefined) {
      delete process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
    } else {
      process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = originalIdleTimeout;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// INT32_MAX is above any pid a real host mints in practice — Linux pid_max caps
// at 2^22, macOS at 99999, and a Windows pid counter would need hundreds of
// millions of process creations to get near 2^31 — so on every host this suite
// runs on the owner is absent and cannot be recycled mid-test. A literal like
// 101 is not: on a Mac with a simulator runtime mounted, PID 101 is a live
// `appleaccountd`, the reaper reads it as ownership-lost, retains the record
// instead of clearing it, and this test goes red on that machine while staying
// green on CI.
const NEVER_A_PID = 2_147_483_647;

test('cleanup reads recorded browser identities without reconstructing a process tree', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  const originalIdleTimeout = process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '1';
  const ownedProcessRecords = {
    read: () => [
      {
        scope: { kind: 'daemon' as const },
        path: path.join(stateDir, 'owned-processes.json'),
        status: 'decoded' as const,
        records: [
          {
            pid: NEVER_A_PID,
            startTime: `start-${NEVER_A_PID}`,
            command: `command-${NEVER_A_PID}`,
            purpose: 'verified-managed-web-browser',
          },
        ],
      },
    ],
    replace: vi.fn(),
    clear: vi.fn(),
  };

  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const result = await cleanupManagedAgentBrowserOrphans(status, 'provider-startup', {
      env: process.env,
      ownedProcessRecords,
    });

    assert.deepEqual(result.pids, [NEVER_A_PID]);
    assert.deepEqual(result.signalPids, []);
    assert.equal(mockRunCmd.mock.calls.length, 0);
    expect(ownedProcessRecords.clear).toHaveBeenCalledOnce();
  } finally {
    if (originalIdleTimeout === undefined) {
      delete process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
    } else {
      process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = originalIdleTimeout;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('process summary reports only conservatively owned managed Chrome processes', () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const marker = agentBrowserChromeLaunchMarker(status);
    const summary = summarizeAgentBrowserProcesses(
      [
        { pid: 101, command: `/opt/chrome ${marker}` },
        { pid: 102, command: `${status.runtimeHomeDir}/.agent-browser/browsers/chrome/chrome` },
        { pid: 103, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      ],
      status,
    );

    assert.equal(summary.count, 2);
    assert.deepEqual(summary.pids, [101, 102]);
    assert.deepEqual(
      summary.processes.map((process) => process.reason),
      ['launch-marker', 'managed-browser-home'],
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

type ProcessFixture = { pid: number; ppid?: number; command: string; executable?: string };

function nativeBinary(installDir: string): string {
  const binary = path.join(
    installDir,
    'package',
    'node_modules',
    'agent-browser',
    'bin',
    'agent-browser-darwin-arm64',
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'fixture');
  return fs.realpathSync.native(binary);
}

function observeProcesses(processes: ProcessFixture[]) {
  mockRunCmd.mockResolvedValue({
    stdout: processes.map(({ pid, ppid = 1, command }) => `  ${pid} ${ppid} ${command}`).join('\n'),
    stderr: '',
    exitCode: 0,
  });
  identitiesMock.mockImplementation(
    async (pids) =>
      new Map(
        [...pids].flatMap((pid) => {
          const row = processes.find((item) => item.pid === pid);
          return row
            ? [[pid, { startTime: `start-${pid}`, command: row.command, zombie: false }]]
            : [];
        }),
      ),
  );
  executablePathsMock.mockImplementation(
    async (pids: Iterable<number>) =>
      new Map(
        [...pids].flatMap((pid) => {
          const executable = processes.find((item) => item.pid === pid)?.executable;
          return executable ? [[pid, executable]] : [];
        }),
      ),
  );
}

test.each([
  ['win32', 'same', [101]],
  ['win32', 'different-file', []],
  ['win32', 'different-device', []],
  ['win32', 'missing', []],
  ['win32', 'unsafe-inode', []],
  ['darwin', 'same', []],
] as const)(
  'case-only executable spelling on %s requires %s file identity',
  async (os, identity, expected) => {
    const stateDir = mkdtempForTestSync('agent-device-web-case-');
    try {
      installFakeManagedAgentBrowser(stateDir);
      const status = getManagedAgentBrowserStatus({
        stateDir,
        host: { env: process.env, cwd: process.cwd() },
      });
      const binary = nativeBinary(status.installDir);
      const observed = binary.replaceAll('\\', '/').toUpperCase();
      probe.platform = os;
      vi.spyOn(hostFile, 'hostFileStatSync').mockImplementation((candidate) => {
        if (candidate === observed && identity === 'missing') throw new Error('unavailable');
        const stats = fs.statSync(candidate === observed ? binary : candidate);
        if (candidate === observed) {
          if (identity === 'different-file') stats.ino += 1;
          if (identity === 'different-device') stats.dev += 1;
          if (identity === 'unsafe-inode') stats.ino = Number.MAX_SAFE_INTEGER + 1;
        }
        return stats;
      });
      observeProcesses([{ pid: 101, command: `${binary} daemon`, executable: observed }]);
      const store = { replace: vi.fn(), clear: vi.fn(), read: vi.fn(() => []) };
      expect((await recordManagedAgentBrowserProcesses(status, store)).pids).toEqual(expected);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  },
);

test('a managed binary symlink cannot confer ownership on an executable outside its install', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-install-boundary-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const binary = nativeBinary(status.installDir);
    const linkedBinary = nativeBinary(managedInstallPaths(stateDir, '0.27.1').installDir);
    const linkedBin = path.dirname(linkedBinary);
    const outsideBin = path.join(stateDir, 'unrelated-bin');
    fs.renameSync(linkedBin, outsideBin);
    fs.symlinkSync(outsideBin, linkedBin, process.platform === 'win32' ? 'junction' : 'dir');
    const unrelated = fs.realpathSync.native(path.join(outsideBin, path.basename(linkedBinary)));
    observeProcesses([
      { pid: 101, command: `${binary} daemon`, executable: binary },
      { pid: 102, command: unrelated, executable: unrelated },
    ]);
    const store = { replace: vi.fn(), clear: vi.fn(), read: vi.fn(() => []) };

    expect((await recordManagedAgentBrowserProcesses(status, store)).pids).toEqual([101]);
    expect(store.replace.mock.calls[0]?.[1].map(({ pid }: { pid: number }) => pid)).toEqual([101]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('records verified current and retained native roots and stable descendants', async () => {
  const stateDir = mkdtempForTestSync('agent-device web life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const current = nativeBinary(status.installDir);
    const previous = managedInstallPaths(stateDir, '0.27.1');
    const retained = nativeBinary(previous.installDir);
    const marker = agentBrowserChromeLaunchMarker(status);
    const rows: ProcessFixture[] = [
      { pid: 101, command: `${current} daemon`, executable: current },
      { pid: 102, command: `${retained} daemon`, executable: retained },
      { pid: 201, ppid: 101, command: `/opt/Chromium ${marker}`, executable: '/opt/Chromium' },
      { pid: 301, ppid: 201, command: 'child' },
      { pid: 999, command: `/tmp/unrelated ${marker}`, executable: '/tmp/unrelated' },
    ];
    observeProcesses(rows);
    const store = { replace: vi.fn(), clear: vi.fn(), read: vi.fn(() => []) };
    const summary = await recordManagedAgentBrowserProcesses(status, store);
    expect(summary.pids).toEqual([101, 102, 201, 301]);
    expect(summary.processes.map(({ reason }) => reason)).toEqual([
      'agent-browser-daemon',
      'agent-browser-daemon',
      'launch-marker',
      'descendant',
    ]);
    expect(store.replace).toHaveBeenCalledWith(
      { kind: 'daemon' },
      rows.slice(0, 4).map(({ pid, command }) => ({
        pid,
        command,
        startTime: `start-${pid}`,
        purpose: 'verified-managed-web-browser',
      })),
    );
    expect(identitiesMock).toHaveBeenCalledTimes(2);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('retained Chrome home and marker roots require a Chrome executable and this state directory', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  const otherStateDir = mkdtempForTestSync('agent-device-web-other-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const previous = managedInstallPaths(stateDir, '0.27.1');
    const other = managedInstallPaths(otherStateDir, '0.27.1');
    fs.mkdirSync(previous.installDir, { recursive: true });
    const otherBinary = nativeBinary(other.installDir);
    const home = path.join(
      previous.runtimeHomeDir,
      '.agent-browser',
      'browsers',
      'chrome-150',
      'chrome',
    );
    const marker = agentBrowserChromeLaunchMarker(previous);
    const rows: ProcessFixture[] = [
      { pid: 201, command: `/opt/Chromium ${marker}`, executable: '/opt/Chromium' },
      { pid: 202, command: `${home} --type=renderer`, executable: home },
      { pid: 203, command: `/opt/Chromium ${marker}`, executable: '/tmp/editor' },
      { pid: 204, command: `${home} --type=renderer` },
      { pid: 205, command: `${otherBinary} daemon`, executable: otherBinary },
      {
        pid: 206,
        command: `/opt/Chromium ${agentBrowserChromeLaunchMarker(other)}`,
        executable: '/opt/Chromium',
      },
    ];
    observeProcesses(rows);
    const store = { replace: vi.fn(), clear: vi.fn(), read: vi.fn(() => []) };
    const summary = await recordManagedAgentBrowserProcesses(status, store);
    expect(summary.pids).toEqual([201, 202]);
    expect(summary.processes.map(({ reason }) => reason)).toEqual([
      'launch-marker',
      'managed-browser-home',
    ]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(otherStateDir, { recursive: true, force: true });
  }
});

test('an unstable root or intermediate process cannot authorize its descendants', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const binary = nativeBinary(status.installDir);
    const rows: ProcessFixture[] = [
      { pid: 101, command: `${binary} daemon`, executable: binary },
      { pid: 102, ppid: 101, command: 'child' },
      { pid: 103, ppid: 102, command: 'grandchild' },
      { pid: 104, command: `${binary} daemon`, executable: binary },
      { pid: 105, ppid: 104, command: 'child of changed root' },
    ];
    observeProcesses(rows);
    identitiesMock.mockImplementationOnce(
      async (pids) =>
        new Map(
          [...pids].map((pid) => [
            pid,
            {
              startTime: `start-${pid}`,
              command: rows.find((row) => row.pid === pid)!.command,
              zombie: false,
            },
          ]),
        ),
    );
    identitiesMock.mockImplementationOnce(
      async (pids) =>
        new Map(
          [...pids].map((pid) => [
            pid,
            {
              startTime: pid === 102 || pid === 104 ? 'changed' : `start-${pid}`,
              command: rows.find((row) => row.pid === pid)!.command,
              zombie: false,
            },
          ]),
        ),
    );
    const store = { replace: vi.fn(), clear: vi.fn(), read: vi.fn(() => []) };
    const summary = await recordManagedAgentBrowserProcesses(status, store);
    expect(summary.pids).toEqual([101]);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('recording refuses a scanned command that differs from the bracketed identity', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const binary = nativeBinary(status.installDir);
    observeProcesses([{ pid: 101, command: `${binary} daemon`, executable: binary }]);
    identitiesMock.mockImplementation(
      async () =>
        new Map([[101, { startTime: 'start-101', command: 'different command', zombie: false }]]),
    );
    const store = { replace: vi.fn(), clear: vi.fn(), read: vi.fn(() => []) };
    expect((await recordManagedAgentBrowserProcesses(status, store)).pids).toEqual([]);
    expect(store.replace).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('recording and reaping require executable provenance and matching identity', async () => {
  const stateDir = mkdtempForTestSync('agent-device web reap-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const binary = nativeBinary(status.installDir);
    const previous = nativeBinary(managedInstallPaths(stateDir, '0.27.1').installDir);
    const rows: ProcessFixture[] = [
      { pid: 11001, command: `${binary} daemon`, executable: binary },
      { pid: 11002, command: `${previous} daemon`, executable: previous },
      { pid: 11003, command: `${binary} daemon`, executable: binary },
      {
        pid: 11004,
        command: `${process.execPath} ${status.entryScript}`,
        executable: process.execPath,
      },
      { pid: 11005, command: `tail -f ${binary}`, executable: '/usr/bin/tail' },
      { pid: 11006, command: `vim ${binary}`, executable: '/usr/bin/vim' },
      { pid: 11007, command: `grep ${binary}`, executable: '/usr/bin/grep' },
      { pid: 11008, command: `${binary} daemon`, executable: '/tmp/other' },
      { pid: 11009, command: `${binary} daemon` },
      { pid: 11010, command: `${binary}-other`, executable: `${binary}-other` },
      {
        pid: 11011,
        command: `${process.execPath} ${status.entryScript}`,
        executable: '/tmp/unrelated-node',
      },
      { pid: 11012, command: `${binary} daemon`, executable: binary.slice(0, binary.indexOf(' ')) },
    ];
    observeProcesses(rows);
    const store = createOwnedProcessRecordStore({
      stateDir,
      sessionsDir: path.join(stateDir, 'sessions'),
      resolveSessionDir: (id) => path.join(stateDir, 'sessions', id),
    });
    await recordManagedAgentBrowserProcesses(status, store);
    const recordedPids = store.read()[0]?.records.map(({ pid }) => pid);
    const alive = new Set(rows.map(({ pid }) => pid));
    const signals: number[] = [];
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: string | number) => {
      if (!alive.has(pid)) throw Object.assign(new Error('absent'), { code: 'ESRCH' });
      if (signal !== 0) {
        signals.push(pid);
        alive.delete(pid);
      }
      return true;
    }) as typeof process.kill);
    await spawnMock.withImplementation(
      (_command: string, args: readonly string[]) => {
        const pid = Number(args[1]);
        const command = rows.find((row) => row.pid === pid)?.command;
        const start = pid === 11003 ? 'changed-start' : `start-${pid}`;
        const stdout = args[3] === 'pid=,command=' ? `${pid} ${command}\n` : `${pid} S ${start}\n`;
        const child = Object.assign(new ChildProcess(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        queueMicrotask(() => {
          child.stdout.end(stdout);
          child.stderr.end();
          child.emit('close', 0, null);
        });
        return child;
      },
      async () => {
        const result = await reapOwnedProcessRecordsAtStartup(store, {
          termTimeoutMs: 1,
          killTimeoutMs: 1,
        });
        expect(signals).toEqual([11001, 11002]);
        expect(result.terminatedPids).toEqual([11001, 11002]);
        expect(result.missingPids).toEqual([11003]);
        expect(recordedPids).toEqual([11001, 11002, 11003]);
      },
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('cleanup retains legacy records without signaling or treating them as verified', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({
      stateDir,
      host: { env: process.env, cwd: process.cwd() },
    });
    const store = createOwnedProcessRecordStore({
      stateDir,
      sessionsDir: path.join(stateDir, 'sessions'),
      resolveSessionDir: (id) => path.join(stateDir, 'sessions', id),
    });
    const legacy = { pid: 11001, command: 'old', startTime: 'old', purpose: 'managed-web-browser' };
    store.replace({ kind: 'daemon' }, [legacy]);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('unexpected signal');
    });
    const result = await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
      env: process.env,
      ownedProcessRecords: store,
    });
    expect(result.pids).toEqual([]);
    expect(await managedWebBrowserProcessRecordIsLive(store)).toBe(false);
    expect(store.read()[0]?.records).toEqual([legacy]);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
