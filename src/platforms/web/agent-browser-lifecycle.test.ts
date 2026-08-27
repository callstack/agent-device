import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

const { runCmdMock } = vi.hoisted(() => ({
  runCmdMock: vi.fn(),
}));

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmd: runCmdMock,
  withoutCommandExecutorOverride: async <T>(fn: () => Promise<T>) => await fn(),
}));

vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return {
    ...actual,
    listHostProcesses: async (options: Parameters<typeof actual.listHostProcesses>[0]) =>
      await actual.listHostProcesses({ ...options, runCommand: runCmdMock }),
    readProcessStartTime: (pid: number) => `start-${pid}`,
    readProcessCommand: (pid: number) => `command-${pid}`,
  };
});

import {
  DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS,
  agentBrowserChromeLaunchMarker,
  appendAgentDeviceChromeArgs,
  cleanupManagedAgentBrowserOrphans,
  matchAgentBrowserChromeProcess,
  recordManagedAgentBrowserProcesses,
  resolveAgentBrowserIdleTimeoutMs,
  summarizeManagedAgentBrowserProcesses,
  summarizeAgentBrowserProcesses,
} from './agent-browser-lifecycle.ts';
import { getManagedAgentBrowserStatus } from './agent-browser-tool.ts';
import { installFakeManagedAgentBrowser } from './__tests__/test-utils.ts';

const mockRunCmd = vi.mocked(runCmdMock);

beforeEach(() => {
  mockRunCmd.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('managed Chrome launch args include a stable agent-device ownership marker once', () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({ stateDir });
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

test('ownership detection accepts only Chrome-like processes with managed markers', () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({ stateDir });
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

    const markerMatch = matchAgentBrowserChromeProcess(
      { pid: 11, command: `/Applications/Chromium.app/Contents/MacOS/Chromium ${marker}` },
      status,
    );
    const homeMatch = matchAgentBrowserChromeProcess(
      { pid: 12, command: `${managedChrome} --type=renderer` },
      status,
    );
    const userChrome = matchAgentBrowserChromeProcess(
      {
        pid: 13,
        command:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --profile-directory=Default',
      },
      status,
    );
    const broadRuntimeHome = matchAgentBrowserChromeProcess(
      { pid: 15, command: `${status.runtimeHomeDir}/profile-cache/chrome-helper` },
      status,
    );
    const markedNonBrowser = matchAgentBrowserChromeProcess(
      { pid: 14, command: `/bin/sh -c echo ${marker}` },
      status,
    );

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
    const status = getManagedAgentBrowserStatus({ stateDir });
    const result = await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
      openWebSessionNames: ['default-web'],
    });

    assert.equal(result.skipped?.reason, 'open-web-session');
    assert.deepEqual(result.skipped?.openWebSessionNames, ['default-web']);
    assert.equal(mockRunCmd.mock.calls.length, 0);
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
    const status = getManagedAgentBrowserStatus({ stateDir });
    fs.mkdirSync(status.socketDir, { recursive: true });
    fs.writeFileSync(path.join(status.socketDir, 'agent-browser.sock'), '');

    const result = await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup');

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
    const status = getManagedAgentBrowserStatus({ stateDir });
    fs.mkdirSync(status.socketDir, { recursive: true });
    mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    const result = await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup');

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
            pid: 101,
            startTime: 'start-101',
            command: 'command-101',
            purpose: 'managed-web-browser',
          },
        ],
      },
    ],
    replace: vi.fn(),
    clear: vi.fn(),
  };

  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({ stateDir });
    const result = await cleanupManagedAgentBrowserOrphans(status, 'provider-startup', {
      ownedProcessRecords,
    });

    assert.deepEqual(result.pids, [101]);
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
    const status = getManagedAgentBrowserStatus({ stateDir });
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

test('records the managed browser daemon and Chrome fleet at the spawn owner', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({ stateDir });
    const marker = agentBrowserChromeLaunchMarker(status);
    const store = { replace: vi.fn(), clear: vi.fn(), read: vi.fn(() => []) };
    mockRunCmd.mockResolvedValue({
      stdout: [
        `  101     1 ${process.execPath} ${status.entryScript}`,
        `  201   101 /Applications/Chromium.app/Contents/MacOS/Chromium ${marker}`,
        '  301   201 /Applications/Chromium.app/Contents/Frameworks/Chromium Helper --type=gpu',
        '  999     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });

    const summary = await recordManagedAgentBrowserProcesses(status, store);

    expect(summary.pids).toEqual([101, 201, 301]);
    expect(store.replace).toHaveBeenCalledWith(
      { kind: 'daemon' },
      [101, 201, 301].map((pid) => ({
        pid,
        startTime: `start-${pid}`,
        command: `command-${pid}`,
        purpose: 'managed-web-browser',
      })),
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('managed process summary includes the recordable agent-browser daemon', () => {
  const stateDir = mkdtempForTestSync('agent-device-web-life-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({ stateDir });
    expect(
      summarizeManagedAgentBrowserProcesses(
        [{ pid: 101, command: `${process.execPath} ${status.entryScript}` }],
        status,
      ).processes[0]?.reason,
    ).toBe('agent-browser-daemon');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
