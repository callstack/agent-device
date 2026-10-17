import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { MissingCompanionEnvError } from './client-companion-tunnel-contract.ts';
import { runCompanionTunnelProcessFromEnv } from './client-companion-tunnel-worker.ts';

void runCompanionTunnelProcessFromEnv(
  process.argv.slice(2),
  captureHostEnvironment(process).env,
).catch((error) => {
  if (error instanceof MissingCompanionEnvError) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
