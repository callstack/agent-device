import { vi } from 'vitest';
import { createRegisteredDaemonFixtures } from '@agent-device/test-kit';
import { stopDaemonProcess } from '@agent-device/daemon-contracts/daemon-process';
import type { DaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonRegistrationFields } from '@agent-device/daemon-contracts/daemon-registration-owner';
import { readDaemonInfo, type DaemonInfo } from '../daemon-client-metadata.ts';

const actualCommand = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);

export const {
  registeredDaemonFixtureArgs,
  launchRegisteredDaemonFixtureArgs,
  spawnRegisteredDaemonFixture,
  waitForFixtureFile,
  waitForRegisteredDaemonFixture,
  finishRegisteredDaemonFixture,
  finishRegisteredDaemonFixtures,
} = createRegisteredDaemonFixtures<DaemonInfo, DaemonPaths, DaemonRegistrationFields>({
  registrationOwnerUrl: import.meta
    .resolve('@agent-device/daemon-contracts/daemon-registration-owner'),
  startupPhasesUrl: import.meta.resolve('@agent-device/daemon-contracts/daemon-startup-phases'),
  launch: actualCommand.runCmdDetachedMonitored,
  stopDaemonProcess,
  readDaemonInfo,
});
