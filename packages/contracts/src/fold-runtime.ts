import type { FoldPose, FoldScreenCoordinateSpace, SetFoldPoseInput } from './device-rotation.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';

/**
 * Mirrors `device-rotation.ts`'s `FOLD_SCREEN_COORDINATE_SPACE` (the single source of truth) as a
 * literal rather than a re-export, so importing this published subpath does not also eagerly load
 * `device-rotation.ts`. The `FoldScreenCoordinateSpace` type import above still makes any drift
 * between the two a compile error.
 */
export const FOLD_SCREEN_COORDINATE_SPACE: FoldScreenCoordinateSpace = 'native-panel';

/**
 * The panel the device lights after the pose settled, in that panel's own native points: its pixel
 * size divided by its point scale, never rotated. `coordinateSpace` is always
 * {@link FoldScreenCoordinateSpace}, and these numbers are NOT snapshot coordinates — the active
 * app window can differ from the panel (iPhone Duo: a 669x951 inner panel hosts a 951x669 app
 * window), so they cannot place a tap. A caller that needs the app viewport must take a fresh
 * snapshot.
 */
export type FoldScreenReport = Readonly<{
  /** The CoreDevice display name of the panel the device now lights. */
  display: string;
  /** Marks these dimensions as the panel's native points, never a snapshot's app viewport. */
  coordinateSpace: FoldScreenCoordinateSpace;
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
