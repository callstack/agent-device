import fs from 'node:fs';
import path from 'node:path';
import { withTestDeviceInventory } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { ANDROID_EMULATOR } from '@agent-device/test-kit';
import type { CliFlags } from '@agent-device/contracts/command';
import { runExecCommand } from '../exec.ts';

// The child-process half of the SIGHUP case in exec.test.ts: a real `exec`
// wrapper receiving a real SIGHUP, exactly as a closed terminal delivers it.
// Only a real signal exercises the wrapper process's own default disposition,
// so the stub inventory runs in the wrapper's process like exec-cli-fixture.ts.
// The child records its pid and replaces the shell with `exec sleep`, keeping
// that pid, so the test can prove the group — not just the wrapper — stopped.
const dirs = JSON.parse(process.env.EXEC_TEST_DIRS ?? '{}') as {
  claimsDir?: string;
  stateDir?: string;
};
const claimsDir = dirs.claimsDir;
const stateDir = dirs.stateDir;
if (!claimsDir || !stateDir) {
  process.stderr.write('exec-hup-fixture: EXEC_TEST_DIRS missing\n');
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

const childPidFile = path.join(stateDir, 'hup-child.pid');
fs.mkdirSync(path.join(stateDir, 'exec'), { recursive: true });
const exitCode = await withTestDeviceInventory(
  { local: async () => [ANDROID_EMULATOR] },
  async () =>
    await runExecCommand(['sh', '-c', `echo $$ > ${JSON.stringify(childPidFile)}; exec sleep 8`], {
      flags,
      stateDir,
    }),
);
process.exit(exitCode);
