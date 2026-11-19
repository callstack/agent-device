import fs from 'node:fs';
import { buildSnapshotState } from '@agent-device/capture-kit/snapshot-state';
import { stampSnapshotIdentity } from '@agent-device/contracts/snapshot-producers';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { TVOS_SIMULATOR } from '../src/__tests__/device-fixtures.ts';
import {
  presentAppleRunnerSnapshot,
  readAppleSnapshotResult,
} from '../src/snapshot-presentation.ts';

const input = JSON.parse(fs.readFileSync(0, 'utf8')) as {
  nodes: RawSnapshotNode[];
  viewport: Rect;
  raw: boolean;
  interactiveOnly: boolean;
};
const read = readAppleSnapshotResult(
  { nodes: input.nodes, snapshotViewport: { kind: 'reported', rect: input.viewport } },
  TVOS_SIMULATOR,
);
const presented = presentAppleRunnerSnapshot(
  TVOS_SIMULATOR,
  { raw: input.raw, interactiveOnly: input.interactiveOnly },
  read,
);
const capture = stampSnapshotIdentity(presented, { backend: 'xctest', producer: 'apple-runner' });
const state = buildSnapshotState(capture, {
  snapshotRaw: input.raw,
  snapshotInteractiveOnly: input.interactiveOnly,
});
process.stdout.write(JSON.stringify({ presented, state }));
