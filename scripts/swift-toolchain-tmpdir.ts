// Xcode 26.2's SwiftPM leaves TemporaryDirectory.* marker directories behind
// even after successful `swift` and `xcodebuild` commands. Keep build-lane
// scratch state under one owned directory so it can be removed deterministically.
// Production runner launches intentionally do not use this wrapper.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCmdBackground } from '../src/utils/exec.ts';

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
});

const FORCE_KILL_DELAY_MS = 5_000;
let forwardedSignal: 'SIGINT' | 'SIGTERM' | undefined;
let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    child.kill(signal);
    // Keep the owned TMPDIR alive while Swift/Xcode handles the signal and
    // flushes its descendants. A stuck child is force-killed after a bounded
    // grace period, after which `wait` resolves and normal exit cleanup runs.
    forceKillTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_DELAY_MS);
    forceKillTimer.unref();
  });
}

const result = await wait;
if (forceKillTimer) clearTimeout(forceKillTimer);
process.exitCode =
  forwardedSignal === 'SIGINT' ? 130 : forwardedSignal === 'SIGTERM' ? 143 : result.exitCode;
