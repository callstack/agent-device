import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { collectIosScrollIndicatorPresentation } from './scroll.ts';
import {
  collectIosReactNativeOverlayActionPresentation,
  collectIosReactNativeOverlayWrapperSuppression,
} from './noise-overlay.ts';
import { collectIosOffscreenKeyboardSuppression } from './noise-viewport.ts';
import { collectIosSearchToolbarSuppression } from './noise-search.ts';
import {
  collectIosActionWrapperSuppression,
  collectIosRepeatedStaticSuppression,
} from './noise-redundancy.ts';
import { collectIosStructuralIdentifierSuppression } from './noise-structural.ts';
import type { SnapshotTreeRuleContext } from './tree.ts';

export function collectIosPresentationNoiseSuppression(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  collectIosOffscreenKeyboardSuppression(nodes, context);
  collectIosStructuralIdentifierSuppression(nodes, context);
  collectIosScrollIndicatorPresentation(nodes, context);
  collectIosSearchToolbarSuppression(nodes, context);
  collectIosActionWrapperSuppression(nodes, context);
  collectIosReactNativeOverlayActionPresentation(nodes, context.replacements);
  collectIosReactNativeOverlayWrapperSuppression(nodes, context);
  collectIosRepeatedStaticSuppression(nodes, context);
}
