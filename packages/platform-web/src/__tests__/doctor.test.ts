import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beforeEach, test, vi } from 'vitest';
import type { AgentBrowserProcessSummary } from '../agent-browser-lifecycle.ts';
import { installFakeManagedAgentBrowser, mkdtempForTestSync } from './test-utils.ts';

vi.mock('../agent-browser-lifecycle.ts', async () => {
  const actual = await vi.importActual<typeof import('../agent-browser-lifecycle.ts')>(
    '../agent-browser-lifecycle.ts',
  );
  return {
    ...actual,
    inspectManagedAgentBrowserProcesses: vi.fn(),
  };
});

const { inspectManagedAgentBrowserProcesses } = await import('../agent-browser-lifecycle.ts');
const { webBrowserLifecycleCheck } = await import('../doctor.ts');

const mockInspectManagedAgentBrowserProcesses = vi.mocked(inspectManagedAgentBrowserProcesses);

beforeEach(() => {
  mockInspectManagedAgentBrowserProcesses.mockReset();
});

test('web doctor lifecycle check reports live managed Chrome process count', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-doctor-');
  try {
    installFakeManagedAgentBrowser(stateDir);
    mockInspectManagedAgentBrowserProcesses.mockResolvedValue({
      count: 2,
      pids: [101, 102],
      processes: [
        {
          process: { pid: 101, command: 'chrome --agent-device-managed-web=abc' },
          reason: 'launch-marker',
        },
        {
          process: { pid: 102, command: 'chrome from managed home' },
          reason: 'managed-browser-home',
        },
      ],
    } satisfies AgentBrowserProcessSummary);

    const check = await webBrowserLifecycleCheck(stateDir);

    assert.equal(check.id, 'web-agent-browser-processes');
    assert.equal(check.status, 'info');
    assert.match(check.summary ?? '', /2 live agent-device-owned Chrome processes/);
    assert.deepEqual(check.evidence?.pids, [101, 102]);
    assert.deepEqual(check.evidence?.matchReasons, ['launch-marker', 'managed-browser-home']);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('web doctor lifecycle check stays informational when managed backend is missing', async () => {
  const stateDir = mkdtempForTestSync('agent-device-web-doctor-missing-');
  try {
    const check = await webBrowserLifecycleCheck(stateDir);

    assert.equal(check.status, 'info');
    assert.match(check.summary ?? '', /not installed/);
    assert.equal(mockInspectManagedAgentBrowserProcesses.mock.calls.length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
