import { vi } from 'vitest';
import { createRegisteredDaemonFixtures } from '@agent-device/test-kit';
import { stopDaemonProcess } from '@agent-device/daemon-contracts/daemon-process';
import {
  readDaemonRecord,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonRegistrationFields } from '@agent-device/daemon-contracts/daemon-registration-owner';

const actualCommand = await vi.importActual<typeof import('@agent-device/host-kit/command')>(
  '@agent-device/host-kit/command',
);

/** The record a registered fixture child published, as far as the root tests read it. */
type PublishedDaemonRecord = { pid: number; processStartTime?: string } & Record<string, unknown>;

function readPublishedDaemonRecord(infoPath: string): PublishedDaemonRecord | null {
  const read = readDaemonRecord(infoPath);
  if (read.status !== 'present' || typeof read.record.pid !== 'number') return null;
  return read.record as PublishedDaemonRecord;
}

export const {
  registeredDaemonFixtureArgs,
  launchRegisteredDaemonFixtureArgs,
  spawnRegisteredDaemonFixture,
  waitForFixtureFile,
  waitForRegisteredDaemonFixture,
  finishRegisteredDaemonFixture,
} = createRegisteredDaemonFixtures<PublishedDaemonRecord, DaemonPaths, DaemonRegistrationFields>({
  registrationOwnerUrl: import.meta
    .resolve('@agent-device/daemon-contracts/daemon-registration-owner'),
  startupPhasesUrl: import.meta.resolve('@agent-device/daemon-contracts/daemon-startup-phases'),
  launch: actualCommand.runCmdDetachedMonitored,
  stopDaemonProcess,
  readDaemonInfo: readPublishedDaemonRecord,
});
