import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

const paths = resolveDaemonPaths(process.env.AGENT_DEVICE_STATE_DIR);

process.stdout.write(`${paths.baseDir}\n`);
