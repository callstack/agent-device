import {
  readHostToolchainIdentity,
  type HostToolchainIdentity,
} from '../native-build/toolchain-identity.ts';
import { SHARED_SNAPSHOT_BRIDGE_READER_FILENAMES } from '@agent-device/apple-runner';
import { fromNativeBuildError, snapshotSourceError } from './errors.ts';
import type { SnapshotSourceDeadline } from './deadline.ts';
import type { SnapshotSourceHost } from './types.ts';

export type SnapshotSourceToolchainIdentity = HostToolchainIdentity &
  Readonly<{
    simulatorRuntime: string;
  }>;

/** The guest bridge: its socket server plus the reader it shares with the runner. */
export const SNAPSHOT_BRIDGE_SOURCE_FILENAMES = [
  'SnapshotBridge.m',
  ...SHARED_SNAPSHOT_BRIDGE_READER_FILENAMES,
] as const;
// Translation units only: an included header belongs in the fingerprint, not argv.
export const SNAPSHOT_BRIDGE_COMPILE_FILENAMES = SNAPSHOT_BRIDGE_SOURCE_FILENAMES.filter(
  (filename) => filename.endsWith('.m'),
);

/**
 * The bridge's toolchain identity: the host's shared native-build toolchain identity
 * (`native-build/toolchain-identity.ts`) plus the simulator runtime the bridge targets, which the
 * fold helper does not depend on and the shared identity therefore does not carry.
 */
export async function readSnapshotSourceToolchain(
  host: SnapshotSourceHost,
  simulatorRuntime: string,
  deadline: SnapshotSourceDeadline,
): Promise<SnapshotSourceToolchainIdentity> {
  const identity = await readHostToolchainIdentity(host, deadline).catch((error: unknown) => {
    throw fromNativeBuildError(error);
  });
  const runtime = simulatorRuntime.trim();
  if (!runtime) throw snapshotSourceError('unsupported', 'simulator-runtime-missing');
  return { ...identity, simulatorRuntime: runtime };
}
