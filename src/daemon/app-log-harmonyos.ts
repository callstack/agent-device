import fs from 'node:fs';
import {
  harmonyDeviceForTarget,
  ensureHdcAvailable,
  runHarmonyHdc,
} from '../platforms/harmonyos/hdc.ts';
import { runCmdBackground } from '../utils/exec.ts';
import { sleep } from '../utils/timeouts.ts';
import { attachChildToStream, createLineWriter, waitForChildExit } from './app-log-stream.ts';
import {
  clearPidFile,
  writePidFile,
  type AppLogResult,
  type AppLogState,
} from './app-log-process.ts';

async function resolveHarmonyPid(deviceId: string, bundleId: string): Promise<string | null> {
  const result = await runHarmonyHdc(
    harmonyDeviceForTarget(deviceId, { name: deviceId, emulator: false }),
    ['shell', 'pidof', bundleId],
    { allowFailure: true },
  );
  const pid = result.stdout.trim().split(/\s+/)[0];
  return pid && /^\d+$/.test(pid) ? pid : null;
}

export async function startHarmonyAppLog(
  deviceId: string,
  bundleId: string,
  stream: fs.WriteStream,
  redactionPatterns: RegExp[],
  pidPath?: string,
): Promise<AppLogResult> {
  await ensureHdcAvailable();
  let state: AppLogState = 'recovering';
  let stopped = false;
  let active: ReturnType<typeof runCmdBackground> | undefined;
  let activeWait: ReturnType<typeof attachChildToStream> | undefined;
  const wait = (async () => {
    try {
      while (!stopped) {
        const pid = await resolveHarmonyPid(deviceId, bundleId);
        if (!pid) {
          state = 'recovering';
          await sleep(1_000);
          continue;
        }
        active = runCmdBackground('hdc', ['-t', deviceId, 'shell', 'hilog', '-P', pid], {
          captureOutput: false,
          allowFailure: true,
        });
        activeWait = attachChildToStream(active.child, stream, {
          endStreamOnClose: false,
          writer: createLineWriter(stream, { redactionPatterns }),
        });
        if (typeof active.child.pid === 'number') writePidFile(pidPath, active.child.pid);
        state = 'active';
        await activeWait;
        clearPidFile(pidPath);
        active = undefined;
        activeWait = undefined;
        if (!stopped) {
          state = 'recovering';
          await sleep(500);
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    } finally {
      stream.end();
      clearPidFile(pidPath);
    }
  })();
  return {
    backend: 'harmonyos',
    getState: () => state,
    startedAt: Date.now(),
    wait,
    stop: async () => {
      stopped = true;
      if (active?.child && !active.child.killed) active.child.kill('SIGINT');
      if (activeWait) await waitForChildExit(activeWait);
      if (active?.child && !active.child.killed) active.child.kill('SIGKILL');
      await waitForChildExit(wait);
      clearPidFile(pidPath);
    },
  };
}
