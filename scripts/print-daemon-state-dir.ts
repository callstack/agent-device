import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

const paths = resolveDaemonPaths(process.env.AGENT_DEVICE_STATE_DIR, { cwd: process.cwd() });

process.stdout.write(`${paths.baseDir}\n`);
