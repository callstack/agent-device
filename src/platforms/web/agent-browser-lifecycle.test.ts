import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  DEFAULT_AGENT_BROWSER_IDLE_TIMEOUT_MS,
  agentBrowserChromeLaunchMarker,
  appendAgentDeviceChromeArgs,
  matchAgentBrowserChromeProcess,
  parseHostProcessList,
  resolveAgentBrowserIdleTimeoutMs,
  summarizeAgentBrowserProcesses,
} from './agent-browser-lifecycle.ts';
import { getManagedAgentBrowserStatus } from './agent-browser-tool.ts';
import { installFakeManagedAgentBrowser } from './__tests__/test-utils.ts';

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
    const markedNonBrowser = matchAgentBrowserChromeProcess(
      { pid: 14, command: `/bin/sh -c echo ${marker}` },
      status,
    );

    assert.equal(markerMatch?.reason, 'launch-marker');
    assert.equal(homeMatch?.reason, 'managed-browser-home');
    assert.equal(userChrome, undefined);
    assert.equal(markedNonBrowser, undefined);
  } finally {
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
