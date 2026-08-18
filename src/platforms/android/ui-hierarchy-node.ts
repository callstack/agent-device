import type { Rect } from '@agent-device/kernel/snapshot';

/** One parsed `<node>` of an Android accessibility tree: reported facts only, plus its children. */
export type AndroidUiHierarchy = {
  type: string | null;
  label: string | null;
  value: string | null;
  identifier: string | null;
  packageName: string | null;
  rect?: Rect;
  enabled?: boolean;
  visibleToUser?: boolean;
  drawingOrder?: number;
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
  children: AndroidUiHierarchy[];
};

export type AndroidNode = AndroidUiHierarchy;

/** A node a touch can act on. */
export function isTouchTarget(node: AndroidNode): boolean {
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

/** Text or an address an agent can read or select by. */
export function hasSemanticContent(node: AndroidNode): boolean {
  return hasMeaningfulLabel(node) || hasMeaningfulIdentifier(node);
}

export function hasMeaningfulLabel(node: AndroidNode): boolean {
  const label = node.label?.trim() ?? '';
  return Boolean(label && !isGenericAndroidId(label));
}

function hasMeaningfulIdentifier(node: AndroidNode): boolean {
  const identifier = node.identifier?.trim() ?? '';
  return Boolean(identifier && !isGenericAndroidId(identifier));
}

export function isGenericAndroidId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^[\w.]+:id\/[\w.-]+$/i.test(trimmed);
}

export function hasPositiveRect(node: AndroidNode): node is AndroidNode & { rect: Rect } {
  return Boolean(node.rect && node.rect.width > 0 && node.rect.height > 0);
}
