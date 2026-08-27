// Xcode 26.2's SwiftPM leaves TemporaryDirectory.* marker directories behind
// even after successful `swift` and `xcodebuild` commands. Keep build-lane
// scratch state under one owned directory so it can be removed deterministically.
// Production runner launches intentionally do not use this wrapper.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCmdBackground } from '@agent-device/host-kit/command';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  throw new Error('Usage: node scripts/swift-toolchain-tmpdir.ts <command> [args...]');
}

const commandTmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), `agent-device-swift-toolchain-${process.pid}-`),
);

let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  fs.rmSync(commandTmpDir, { recursive: true, force: true });
}
process.on('exit', cleanup);

const { child, wait } = runCmdBackground(command, args, {
  env: { ...process.env, TMPDIR: commandTmpDir },
  stdio: 'inherit',
  captureOutput: false,
  allowFailure: true,
  detached: process.platform !== 'win32',
});

const FORCE_KILL_DELAY_MS = 5_000;
const FORCE_KILL_WAIT_MS = 1_000;
const PROCESS_GROUP_POLL_MS = 25;
const processGroupId = process.platform !== 'win32' ? child.pid : undefined;
let forwardedSignal: 'SIGINT' | 'SIGTERM' | undefined;
let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
let forceKillDeadline: number | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    signalToolchain(signal);
    // Keep the owned TMPDIR alive while Swift/Xcode handles the signal and
    // flushes its descendants. A stuck process group is force-killed after a
    // bounded grace period, after which normal exit cleanup can run.
    forceKillDeadline = Date.now() + FORCE_KILL_DELAY_MS;
    forceKillTimer = setTimeout(() => signalToolchain('SIGKILL'), FORCE_KILL_DELAY_MS);
    forceKillTimer.unref();
  });
}

const result = await wait;
if (processGroupId) {
  const gracefulDeadline = forceKillDeadline ?? Date.now() + FORCE_KILL_DELAY_MS;
  const exitedGracefully = await waitForProcessGroupExit(
    processGroupId,
    Math.max(0, gracefulDeadline - Date.now()),
  );
  if (!exitedGracefully) {
    signalToolchain('SIGKILL');
    await waitForProcessGroupExit(processGroupId, FORCE_KILL_WAIT_MS);
  }
}
if (forceKillTimer) clearTimeout(forceKillTimer);
process.exitCode =
  forwardedSignal === 'SIGINT' ? 130 : forwardedSignal === 'SIGTERM' ? 143 : result.exitCode;

function signalToolchain(signal: NodeJS.Signals): void {
  if (processGroupId) {
    try {
      process.kill(-processGroupId, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}

async function waitForProcessGroupExit(processGroup: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessGroupAlive(processGroup)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, PROCESS_GROUP_POLL_MS));
  }
  return true;
}

function isProcessGroupAlive(processGroup: number): boolean {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
