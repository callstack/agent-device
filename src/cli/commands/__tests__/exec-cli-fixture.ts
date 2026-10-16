import fs from 'node:fs';
import path from 'node:path';
import { withTestDeviceInventory } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { ANDROID_EMULATOR } from '@agent-device/test-kit';
import type { CliFlags } from '@agent-device/contracts/command';
import { runExecCommand } from '../exec.ts';

// The child-process half of the SIGKILL case in exec.test.ts: a real `exec`
// wrapper whose device selection resolves through the stub inventory, so the
// test can kill the wrapper mid-child without a simulator. Paths arrive via
// EXEC_TEST_DIRS; the claim root is exported so the wrapper's own child
// inherits it.
const dirs = JSON.parse(process.env.EXEC_TEST_DIRS ?? '{}') as {
  claimsDir?: string;
  stateDir?: string;
};
const claimsDir = dirs.claimsDir;
const stateDir = dirs.stateDir;
if (!claimsDir || !stateDir) {
  process.stderr.write('exec-cli-fixture: EXEC_TEST_DIRS missing\n');
  process.exit(2);
}
process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;

const flags: CliFlags = {
  json: false,
  help: false,
  version: false,
  platform: 'android',
  serial: ANDROID_EMULATOR.id,
};

fs.mkdirSync(path.join(stateDir, 'exec'), { recursive: true });
// A short child bounds the leak when the wrapper is SIGKILLed: the claim goes
// stale the moment the wrapper's pid is gone, and a `sleep` descendant that
// outlives the direct child is exactly what must not keep the device fenced.
const exitCode = await withTestDeviceInventory(
  { local: async () => [ANDROID_EMULATOR] },
  async () => await runExecCommand(['sh', '-c', 'sleep 10'], { flags, stateDir }),
);
process.exit(exitCode);
