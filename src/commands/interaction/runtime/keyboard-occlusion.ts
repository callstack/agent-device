import type { Point, Rect, SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import { createSnapshotVisibility } from '@agent-device/contracts/snapshot';
import {
  resolveKeyboardTapOcclusion,
  TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS,
  type KeyboardSurface,
} from '@agent-device/contracts/tap-keyboard-occlusion';
import { interactionVerb } from './interaction-verb.ts';
import type { InteractionAction } from './resolution.ts';

/**
 * The keyboard guard every acting path runs against the tree it already holds.
 *
 * A keyboard is a separate system surface, so it is invisible to the same-window occlusion
 * classifier and harmless to the viewport rule (#2589) — this is the seam that closes both. Living
 * beside the off-screen guard rather than inside any one command keeps the fast path honest: the
 * native-ref preflight enters through the same door as selector and `@ref` resolution, so a backend
 * that "succeeds" cannot do so on a target the shared rule would refuse (ADR 0011).
 */

/**
 * Refuses an acting target whose tap point sits behind the visible keyboard. Fails open whenever the
 * tree cannot name the keyboard's band, which is the same stance the scroll keyboard policy takes:
 * an unmeasurable keyboard is not evidence that a surface is blocked.
 */
export function assertTapTargetClearOfVisibleKeyboard(params: {
  nodes: SnapshotState['nodes'];
  node: SnapshotNode;
  action: InteractionAction;
  /** How the caller named the target, e.g. `Ref @e40` or `Selector text=Form`. */
  label: string;
  /**
   * The point this interaction taps with: the one a coordinate-dispatching path resolved through the
   * same resolver it dispatches with, or the rect center for the native-ref fast path, which hands the
   * element to the platform and lets it choose. Null when the node has no measurable point.
   */
  tapPoint: Point | null;
}): void {
  const targetRect = params.node.rect;
  if (!targetRect || !params.tapPoint) return;
  const occlusion = resolveKeyboardTapOcclusion({
    nodes: params.nodes,
    viewport: createSnapshotVisibility(params.nodes).resolveViewport(targetRect),
    point: params.tapPoint,
    node: params.node,
  });
  if (occlusion.kind !== 'occluded') return;
  throw buildKeyboardOcclusionError({
    label: params.label,
    action: params.action,
    ref: params.node.ref,
    targetRect,
    surface: occlusion.surface,
  });
}

/**
 * The coordinate path's disclosure for the same decision. Raw coordinates are the escape hatch of
 * record — they name a point rather than an element, they are how a keyboard's own control is
 * tapped, and this path never captures the tree it is measured against, so the last-known snapshot
 * can be arbitrarily stale. Refusing on that evidence would guess; naming the reason in the response
 * warning is what stops the misfire from being silent.
 */
export function describeKeyboardOccludedPointWarning(params: {
  nodes: SnapshotState['nodes'];
  point: Point;
  /** The caller's own viewport lookup for this point, shared with the viewport warning above it. */
  viewport: Rect | null;
}): string | undefined {
  const occlusion = resolveKeyboardTapOcclusion({
    nodes: params.nodes,
    viewport: params.viewport,
    point: params.point,
  });
  if (occlusion.kind !== 'occluded') return undefined;
  return keyboardOcclusionWarning(params.point, occlusion.surface);
}

function keyboardOcclusionWarning(point: Point, surface: KeyboardSurface): string {
  return (
    `(${point.x}, ${point.y}) is behind the visible keyboard, so this tap lands on the keyboard ` +
    `rather than anything under it (${TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS.reason}; ` +
    'keyboard frame ' +
    `${Math.round(surface.frame.y)}..${Math.round(surface.frame.y + surface.frame.height)}). ` +
    TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS.hint
  );
}

function buildKeyboardOcclusionError(params: {
  label: string;
  action: InteractionAction;
  ref: string;
  targetRect: NonNullable<SnapshotNode['rect']>;
  surface: KeyboardSurface;
}): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${params.label} is behind the visible keyboard and cannot ${interactionVerb(params.action)} safely`,
    {
      ...TAP_KEYBOARD_OCCLUDES_TARGET_DETAILS,
      ref: `@${params.ref}`,
      rect: params.targetRect,
      keyboardFrame: params.surface.frame,
    },
  );
}
