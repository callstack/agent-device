import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, test, vi } from 'vitest';
import type { ExecBackgroundResult } from '@agent-device/host-kit/command';
import { createAppleRunnerRuntimeState } from '../../core/runner-owner-state.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import { registerRunnerPrepProcess } from '../runner-artifact.ts';
import { stopAllIosRunnerSessions } from '../runner-session.ts';
import { openRunnerStartAdmission, runnerPrepProcessChildren } from '../runner-xctestrun.ts';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';

const mockSignalProcessGroupBestEffort = vi.fn();
const mockRunAppleToolCommand = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  mockRunAppleToolCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  appleRunnerTestHost.update({
    runAppleToolCommand: mockRunAppleToolCommand,
    signalProcessGroupBestEffort: mockSignalProcessGroupBestEffort,
    signalPidsBestEffort: vi.fn(),
  });
});

function prepChild(pid: number): ExecBackgroundResult['child'] {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
  }) as ExecBackgroundResult['child'];
}

test("stopping every runner of one runtime leaves another runtime's prep build and admission alone", async () => {
  const runtimeA = createAppleRunnerRuntimeState(createLiveTestHostEnvironment());
  const runtimeB = createAppleRunnerRuntimeState(createLiveTestHostEnvironment());
  const deviceId = 'runner-runtime-isolation-sim';
  const buildA = prepChild(6101);
  const buildB = prepChild(6102);

  runtimeA.run(() => {
    registerRunnerPrepProcess(deviceId, buildA, openRunnerStartAdmission(deviceId));
  });
  const admissionB = runtimeB.run(() => {
    const admission = openRunnerStartAdmission(deviceId);
    registerRunnerPrepProcess(deviceId, buildB, admission);
    return admission;
  });

  await runtimeA.run(async () => await stopAllIosRunnerSessions());

  const signaled = mockSignalProcessGroupBestEffort.mock.calls.map(([pid]) => pid as number);
  assert.ok(signaled.includes(6101), 'runtime A stopped its own build');
  assert.ok(!signaled.includes(6102), "runtime A never signaled runtime B's build");
  assert.equal(
    runtimeA.run(() => runnerPrepProcessChildren(deviceId).length),
    0,
  );
  assert.equal(
    runtimeB.run(() => runnerPrepProcessChildren(deviceId).length),
    1,
  );
  assert.equal(admissionB.admitted, true, "runtime B's start admission stays open");
});
