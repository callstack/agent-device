import crypto from 'node:crypto';
import fs from 'node:fs';
import type { GuestMechanismEvidence } from './types.ts';

export const EXPECTED_GUEST_BINARY_SHA256 =
  '3545621d2dc98de32879ebac55e8b0c33dc8eb7cc2bfbc2d0d2d21a002c8de58';

export function readVerifiedGuestMechanism(guestBridge: string): GuestMechanismEvidence {
  const observed = sha256File(guestBridge);
  if (observed !== EXPECTED_GUEST_BINARY_SHA256) {
    throw new Error(
      `Guest bridge SHA-256 mismatch: expected ${EXPECTED_GUEST_BINARY_SHA256}, observed ${observed}.`,
    );
  }
  return {
    implementation: 'idb',
    release: 'v1.5.2',
    companionArchive: 'idb-companion.macos-arm64.tar.gz',
    companionSha256: 'f17b718a513931705542a7fbfa9cfc11895ee191562c9ffd2343cf7f8254bc08',
    guestBinary: 'Resources/SimulatorFrameworkBridge',
    guestBinaryExpectedSha256: EXPECTED_GUEST_BINARY_SHA256,
    guestBinarySha256: observed,
    transport:
      'xcrun simctl spawn <udid> SimulatorFrameworkBridge accessibility serve <socket> --idle-timeout 300 --exit-on-disconnect true; UNIX socket frames are a 4-byte big-endian length + JSON',
    traversal:
      'describe with snapshotTree=true (one XCTest snapshot fetch per read) and automationMode=true asserted per request; no idb_companion, gRPC, or Python client',
    client: 'node-direct-socket',
  };
}

export function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
