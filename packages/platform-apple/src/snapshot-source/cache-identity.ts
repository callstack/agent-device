import {
  readHostToolchainIdentity,
  type HostToolchainIdentity,
} from '../native-build/toolchain-identity.ts';
import { fromNativeBuildError, snapshotSourceError } from './errors.ts';
import type { SnapshotSourceDeadline } from './deadline.ts';
import type { SnapshotSourceHost } from './types.ts';

export type SnapshotSourceToolchainIdentity = HostToolchainIdentity &
  Readonly<{
    simulatorRuntime: string;
  }>;

export const SNAPSHOT_BRIDGE_SOURCE_FILENAMES = [
  'SnapshotBridge.m',
  'SnapshotBridgeRuntime.m',
  'SnapshotBridgeRuntime.h',
  'SnapshotBridgeCapture.h',
  'SnapshotBridgeCapture.m',
] as const;
export const SNAPSHOT_BRIDGE_COMPILE_FILENAMES = [
  'SnapshotBridge.m',
  'SnapshotBridgeRuntime.m',
  'SnapshotBridgeCapture.m',
] as const;

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
