import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';
import { appleRunnerTestHost } from '../test-host.ts';

const HOST_ENVIRONMENT_SLOT = Symbol('appleRunnerTestHostEnvironment');
const hostSlot = (): { host: HostEnvironment | undefined } =>
  appleRunnerTestHost
    .defaults()
    .runnerRuntimeSlot(HOST_ENVIRONMENT_SLOT, () => ({ host: undefined }));

/**
 * Makes the runner read its configuration from the host the current runtime bound, the way a
 * composed runtime does (#3794). Call {@link bindRuntimeHostEnvironment} inside each runtime's
 * entered state; a runtime that bound none answers with the live process host.
 */
export function installRuntimeHostEnvironment(): void {
  appleRunnerTestHost.update({
    hostEnvironment: () => hostSlot().host ?? createLiveTestHostEnvironment(),
  });
}

export function bindRuntimeHostEnvironment(host: HostEnvironment): void {
  hostSlot().host = host;
}
