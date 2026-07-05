import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import type { AgentBrowserProcessSummary } from '../../../platforms/web/agent-browser-lifecycle.ts';
import { installFakeManagedAgentBrowser } from '../../../platforms/web/__tests__/test-utils.ts';
import type { DoctorCheck } from '../session-doctor-types.ts';

vi.mock('../../../platforms/web/agent-browser-lifecycle.ts', async () => {
  const actual = await vi.importActual<
    typeof import('../../../platforms/web/agent-browser-lifecycle.ts')
  >('../../../platforms/web/agent-browser-lifecycle.ts');
  return {
    ...actual,
    inspectManagedAgentBrowserProcesses: vi.fn(),
  };
});

const { inspectManagedAgentBrowserProcesses } =
  await import('../../../platforms/web/agent-browser-lifecycle.ts');
const { appendWebBrowserLifecycleCheck } = await import('../session-doctor-web.ts');

const mockInspectManagedAgentBrowserProcesses = vi.mocked(inspectManagedAgentBrowserProcesses);

beforeEach(() => {
  mockInspectManagedAgentBrowserProcesses.mockReset();
});

test('web doctor lifecycle check reports live managed Chrome process count', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-doctor-'));
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

    const checks: DoctorCheck[] = [];
    await appendWebBrowserLifecycleCheck(checks, stateDir);

    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.id, 'web-agent-browser-processes');
    assert.equal(checks[0]?.status, 'info');
    assert.match(checks[0]?.summary ?? '', /2 live agent-device-owned Chrome processes/);
    assert.deepEqual(checks[0]?.evidence?.pids, [101, 102]);
    assert.deepEqual(checks[0]?.evidence?.matchReasons, ['launch-marker', 'managed-browser-home']);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('web doctor lifecycle check stays informational when managed backend is missing', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-web-doctor-missing-'));
  try {
    const checks: DoctorCheck[] = [];
    await appendWebBrowserLifecycleCheck(checks, stateDir);

    assert.equal(checks[0]?.status, 'info');
    assert.match(checks[0]?.summary ?? '', /not installed/);
    assert.equal(mockInspectManagedAgentBrowserProcesses.mock.calls.length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
