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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    child.kill(signal);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

const result = await wait;
process.exitCode = result.exitCode;
