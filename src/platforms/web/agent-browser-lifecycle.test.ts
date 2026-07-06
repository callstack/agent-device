import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';

const { runCmdMock } = vi.hoisted(() => ({
  runCmdMock: vi.fn(),
}));

vi.mock('../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/exec.ts')>();
  return {
    ...actual,
    runCmd: runCmdMock,
    withoutCommandExecutorOverride: async <T>(fn: () => Promise<T>) => await fn(),
  };
});

import {
  DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS,
  agentBrowserChromeLaunchMarker,
  appendAgentDeviceChromeArgs,
  cleanupManagedAgentBrowserOrphans,
  expandProcessTree,
  matchAgentBrowserChromeProcess,
  parseHostProcessList,
  resolveAgentBrowserIdleTimeoutMs,
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-life-'));
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

test('host process parser preserves command text after pid and parent pid', () => {
  assert.deepEqual(
    parseHostProcessList(
      [
        '  101     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '  202   101 /tmp/chrome --type=renderer --flag value',
        'not a process',
      ].join('\n'),
    ),
    [
      {
        pid: 101,
        ppid: 1,
        command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      { pid: 202, ppid: 101, command: '/tmp/chrome --type=renderer --flag value' },
    ],
  );
});

test('ownership detection accepts only Chrome-like processes with managed markers', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-life-'));
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-life-'));
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-life-'));
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-life-'));
  const originalIdleTimeout = process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '60000';
  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({ stateDir });
    fs.mkdirSync(status.socketDir, { recursive: true });
    mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

    const result = await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup');

    assert.equal(result.skipped, undefined);
    assert.equal(mockRunCmd.mock.calls.length, 1);
  } finally {
    if (originalIdleTimeout === undefined) {
      delete process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
    } else {
      process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = originalIdleTimeout;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('process tree expansion includes descendants of matched browser roots', () => {
  const expanded = expandProcessTree(
    [{ process: { pid: 101, ppid: 1, command: 'chrome' }, reason: 'launch-marker' }],
    [
      { pid: 101, ppid: 1, command: 'chrome' },
      { pid: 201, ppid: 101, command: 'Chrome Helper --type=renderer' },
      { pid: 301, ppid: 201, command: 'Chrome Helper --type=gpu' },
      { pid: 999, ppid: 1, command: 'Google Chrome' },
    ],
  );

  assert.deepEqual(
    expanded.map((processInfo) => processInfo.pid),
    [101, 201, 301],
  );
});

test('cleanup signals matched browser process trees with TERM then KILL only for live pids', async () => {
  vi.useFakeTimers();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-life-'));
  const originalIdleTimeout = process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS = '1';
  const alivePids = new Set([101, 201, 301, 999]);
  const killCalls: Array<{ pid: number; signal: string | number | undefined }> = [];
  const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    const numericPid = Number(pid);
    killCalls.push({ pid: numericPid, signal });
    if (signal === 'SIGKILL') alivePids.delete(numericPid);
    if (signal === 0 && !alivePids.has(numericPid)) {
      const error = new Error('not found') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    }
    return true;
  });

  try {
    installFakeManagedAgentBrowser(stateDir);
    const status = getManagedAgentBrowserStatus({ stateDir });
    const marker = agentBrowserChromeLaunchMarker(status);
    mockRunCmd.mockResolvedValue({
      stdout: [
        `  101     1 /Applications/Chromium.app/Contents/MacOS/Chromium ${marker}`,
        '  201   101 /Applications/Chromium.app/Contents/Frameworks/Chromium Helper --type=renderer',
        '  301   201 /Applications/Chromium.app/Contents/Frameworks/Chromium Helper --type=gpu',
        '  999     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    });

    const cleanup = cleanupManagedAgentBrowserOrphans(status, 'provider-startup');
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await cleanup;

    assert.deepEqual(result.pids, [101]);
    assert.deepEqual(result.signalPids, [101, 201, 301]);
    assert.deepEqual(
      killCalls.filter((call) => call.signal === 'SIGTERM').map((call) => call.pid),
      [101, 201, 301],
    );
    assert.deepEqual(
      killCalls.filter((call) => call.signal === 'SIGKILL').map((call) => call.pid),
      [101, 201, 301],
    );
    assert.equal(
      killCalls.some((call) => call.pid === 999),
      false,
    );
    assert.equal(killSpy.mock.calls.length > 0, true);
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-life-'));
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
