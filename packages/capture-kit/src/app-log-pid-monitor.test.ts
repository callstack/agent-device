import { describe, expect, test, vi } from 'vitest';
import type { AppLogBackgroundProcess } from '@agent-device/contracts/platform';
import { monitorPidScopedProcess } from './app-log-pid-monitor.ts';
import { controlledSleeps, deferred, processFixture } from './app-log-pid-process.fixtures.ts';

describe('PID-scoped app-log monitor', () => {
  test('rotates a live stream when the app PID changes', async () => {
    const first = processFixture(deferred<{ stdout: string; stderr: string; exitCode: number }>());
    const second = processFixture(deferred<{ stdout: string; stderr: string; exitCode: number }>());
    const sleeps = controlledSleeps();
    const resolvePid = vi.fn(async () => '456');
    const startProcess = vi.fn(async () => second.process);
    let stopped = false;
    let active: AppLogBackgroundProcess | undefined;
    const monitor = monitorPidScopedProcess({
      initialProcess: { pid: '123', process: first.process },
      stopped: () => stopped,
      setActive: (process) => {
        active = process;
      },
      setState: vi.fn(),
      resolvePid,
      startProcess,
      sleep: sleeps.sleep,
    });

    await vi.waitFor(() => expect(sleeps.pending()).toBe(1));
    sleeps.releaseNext();
    await vi.waitFor(() => expect(first.terminate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(sleeps.pending()).toBe(1));
    sleeps.releaseNext();
    await vi.waitFor(() => expect(startProcess).toHaveBeenCalledWith('456'));
    await vi.waitFor(() => expect(sleeps.pending()).toBe(1));

    stopped = true;
    await active?.terminate();
    await expect(monitor).resolves.toBeUndefined();
    expect(resolvePid).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.terminate).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
  });
});
