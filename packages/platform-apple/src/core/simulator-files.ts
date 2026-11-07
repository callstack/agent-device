import { resolveAppleToolProvider } from './tool-provider.ts';
import type { AppleSimulatorFileCopy } from './tool-provider-types.ts';

/** Copies a simulator container file through the active host's transport. */
export async function copySimulatorFileToHost(request: AppleSimulatorFileCopy): Promise<void> {
  request.signal?.throwIfAborted();
  await resolveAppleToolProvider().simulatorFiles.copyToHost(request);
}
