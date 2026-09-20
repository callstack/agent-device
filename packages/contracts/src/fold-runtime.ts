import type { FoldPose } from './device-rotation.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';

/**
 * Neutral intent for one hinge pose change. `pose` is already parsed by the caller
 * (`parseFoldPose`); the operation names no command, request, session, or CLI flag, and it
 * carries no runner metadata because no runner takes part in a fold.
 */
export type SetFoldPoseInput = Readonly<{ pose: FoldPose }>;

/**
 * The lit panel after the pose settled, in the points the next snapshot will use. Reported so an
 * agent can see that the coordinate space changed without a second capture.
 */
export type FoldScreenReport = Readonly<{
  /** The CoreDevice display name of the panel the device now lights. */
  display: string;
  widthPt: number;
  heightPt: number;
}>;

/**
 * The owner's own closed result: the pose it verified on the device, the hinge angle that
 * verification read, and the panel that ended up lit. An owner reports a pose only after reading
 * it back, so there is no unconfirmed variant here — a pose the owner could not verify is an error.
 */
export type SetFoldPoseResult = Readonly<{
  pose: FoldPose;
  hingeAngleDegrees: number;
  screen?: FoldScreenReport;
}>;

export type FoldRuntimeOperations = Readonly<{
  setFoldPose(input: SetFoldPoseInput): Promise<SetFoldPoseResult>;
}>;

export type FoldRuntimeOperationFacts = Readonly<{
  setFoldPose: RuntimeOperationFact;
}>;

export function foldRuntimeOperationFacts(
  input: Readonly<{ fold: RuntimeOperationFact }>,
): FoldRuntimeOperationFacts {
  return Object.freeze({ setFoldPose: input.fold });
}
