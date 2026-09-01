import type { CommandFlags } from '@agent-device/contracts/command';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import type { DaemonCommandContext } from '../../context.ts';
import { isSparseSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { snapshotOptionsToFlags } from '../../../backend-snapshot-options.ts';
import type {
  BoundContextFromFlags,
  InteractionSessionView,
  InteractionSnapshotOptions,
} from './types.ts';

export type InteractionSnapshotCapture = (params: {
  flags: CommandFlags;
  options: InteractionSnapshotOptions;
  context: DaemonCommandContext;
}) => Promise<SnapshotState>;

export async function captureInteractionSnapshot(params: {
  session: InteractionSessionView;
  flags: CommandFlags | undefined;
  contextFromFlags: BoundContextFromFlags;
  options: InteractionSnapshotOptions;
  capture: InteractionSnapshotCapture;
  publishSnapshot: (snapshot: SnapshotState) => void;
}): Promise<SnapshotState> {
  const { session, flags, contextFromFlags, options } = params;
  const effectiveFlags = {
    ...(flags ?? {}),
    ...snapshotOptionsToFlags(options),
  };
  const dispatchContext = contextFromFlags(
    effectiveFlags,
    session.appBundleId,
    session.trace?.outPath,
  );
  const snapshot = await params.capture({
    flags: effectiveFlags,
    options,
    context: dispatchContext,
  });
  if (!isSparseSnapshotQualityVerdict(snapshot.snapshotQuality)) params.publishSnapshot(snapshot);
  return snapshot;
}
