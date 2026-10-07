import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';

/** Normalized attributes carried unchanged into the public node, independent of presentation. */
type AndroidPassiveNodeFacts = Pick<
  RawSnapshotNode,
  | 'contentDescription'
  | 'enabled'
  | 'selected'
  | 'heading'
  | 'roleDescription'
  | 'checked'
  | 'editable'
  | 'password'
  | 'hintShowing'
  | 'placeholder'
  | 'selectionStart'
  | 'selectionEnd'
>;

/**
 * One normalized Android accessibility node presented to the snapshot engine. Helper/API-specific
 * acquisition facts are intentionally excluded at the metadata-to-hierarchy boundary.
 */
export type AndroidUiHierarchy = {
  type: string | null;
  label: string | null;
  value: string | null;
  passiveFacts: AndroidPassiveNodeFacts;
  identifier: string | null;
  packageName: string | null;
  rect?: Rect;
  visibleToUser?: boolean;
  focused?: boolean;
  // Two independent facts, never collapsed, and never undefined: the helper omits false attributes
  // while stock UiAutomator writes them out, so reading an absent attribute as a value gave two
  // encodings of one control opposite answers.
  clickable: boolean;
  focusable: boolean;
  depth: number;
  parentIndex?: number;
  scrollable?: boolean;
  canScrollForward?: boolean;
  canScrollBackward?: boolean;
  windowIndex?: number;
  windowType?: number;
  windowLayer?: number;
  windowActive?: boolean;
  windowFocused?: boolean;
  windowRect?: Rect;
  /**
   * Whether this input method window's touchable region is one rect, so `windowRect` is exactly the
   * area it takes touches in. Absent below API 33, on other window types, and on older helpers.
   */
  windowRegionRect?: boolean;
  children: AndroidUiHierarchy[];
};

export type AndroidNode = AndroidUiHierarchy;

/** `AccessibilityWindowInfo.TYPE_APPLICATION`, as carried in `windowType`. */
export const ANDROID_WINDOW_TYPE_APPLICATION = 1;
/** `AccessibilityWindowInfo.TYPE_INPUT_METHOD`, as carried in `windowType`. */
export const ANDROID_WINDOW_TYPE_INPUT_METHOD = 2;

export type AndroidSiblingOrder = { parent: AndroidNode; order: number };

const siblingOrderByNode = new WeakMap<AndroidNode, AndroidSiblingOrder>();

export function attachAndroidSiblingOrder(
  node: AndroidNode,
  siblingOrder: AndroidSiblingOrder | undefined,
): AndroidNode {
  if (siblingOrder) siblingOrderByNode.set(node, siblingOrder);
  return node;
}

export function readAndroidSiblingOrder(node: AndroidNode): AndroidSiblingOrder | undefined {
  return siblingOrderByNode.get(node);
}

/** A node a touch can act on. */
function isTouchTarget(node: AndroidNode): boolean {
  return node.clickable;
}

/** A node D-pad/keyboard traversal can land on. Normal for TV controls, which are rarely clickable. */
function isFocusTarget(node: AndroidNode): boolean {
  return node.focusable || node.focused === true;
}

/** A node an agent can drive by either input model. This is what the public `hittable` projects. */
export function isAgentTarget(node: AndroidNode): boolean {
  return isTouchTarget(node) || isFocusTarget(node);
}

export function isGenericAndroidId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[\w.]+:id\/[\w.-]+$/i.test(trimmed);
}
