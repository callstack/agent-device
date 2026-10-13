import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import {
  annotateKeyboardOwnership,
  observeProviderKeyboard,
} from '@agent-device/contracts/tap-keyboard-occlusion';

/** Preserves provider keyboard geometry and ownership before snapshot projection. */
export function acquireProviderKeyboard(params: {
  nodes: readonly RawSnapshotNode[];
  viewport: Rect | null;
  visibility?: boolean | 'unsupported' | 'failed';
}) {
  return {
    nodes: annotateKeyboardOwnership(params.nodes),
    keyboard: observeProviderKeyboard(params),
  };
}
