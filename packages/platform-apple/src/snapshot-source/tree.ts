import {
  isGeometricallyActionable,
  isPositiveFiniteRect,
  isRectVisibleInViewport,
} from '@agent-device/kernel/rect';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import type { IosViewportEvidence } from '@agent-device/contracts/ios-snapshot';
import { snapshotSourceError } from './errors.ts';
import { isQuarterTurnedWindowFrame } from './window-coordinate-space.ts';
import type { SnapshotSourceDecodedTree, SnapshotSourceLimits } from './types.ts';
import { isRecord } from './protocol.ts';

// fallow-ignore-next-line code-duplication
const ATTRIBUTE = Object.freeze({
  elementType: 'XC_kAXXCAttributeElementType',
  elementBaseType: 'XC_kAXXCAttributeElementBaseType',
  label: 'XC_kAXXCAttributeLabel',
  value: 'XC_kAXXCAttributeValue',
  placeholder: 'XC_kAXXCAttributePlaceholderValue',
  identifier: 'XC_kAXXCAttributeIdentifier',
  frame: 'XC_kAXXCAttributeFrame',
  automationType: 'XC_kAXXCAttributeAutomationType',
  traits: 'XC_kAXXCAttributeTraits',
  userInteractionEnabled: 'XC_kAXXCAttributeIsUserInteractionEnabled',
  children: 'XC_kAXXCAttributeChildren',
});

const ELEMENT_TYPE_NAMES: readonly string[] = [
  'Other',
  'Other',
  'Application',
  'Group',
  'Window',
  'Sheet',
  'Drawer',
  'Alert',
  'Dialog',
  'Button',
  'RadioButton',
  'RadioGroup',
  'CheckBox',
  'DisclosureTriangle',
  'PopUpButton',
  'ComboBox',
  'MenuButton',
  'ToolbarButton',
  'Popover',
  'Keyboard',
  'Key',
  'NavigationBar',
  'TabBar',
  'TabGroup',
  'Toolbar',
  'StatusBar',
  'Table',
  'TableRow',
  'TableColumn',
  'Outline',
  'OutlineRow',
  'Browser',
  'CollectionView',
  'Slider',
  'PageIndicator',
  'ProgressIndicator',
  'ActivityIndicator',
  'SegmentedControl',
  'Picker',
  'PickerWheel',
  'Switch',
  'Toggle',
  'Link',
  'Image',
  'Icon',
  'SearchField',
  'ScrollView',
  'ScrollBar',
  'StaticText',
  'TextField',
  'SecureTextField',
  'DatePicker',
  'TextView',
  'Menu',
  'MenuItem',
  'MenuBar',
  'MenuBarItem',
  'Map',
  'WebView',
  'IncrementArrow',
  'DecrementArrow',
  'Timeline',
  'RatingIndicator',
  'ValueIndicator',
  'SplitGroup',
  'Splitter',
  'RelevanceIndicator',
  'ColorWell',
  'HelpTag',
  'Matte',
  'DockItem',
  'Ruler',
  'RulerMarker',
  'Grid',
  'LevelIndicator',
  'Cell',
  'LayoutArea',
  'LayoutItem',
  'Handle',
  'Stepper',
  'Tab',
  'TouchBar',
  'StatusItem',
];

const CLASS_PROMOTED_TYPES: Readonly<Record<string, string>> = {
  UIApplication: 'Application',
  UIWindow: 'Window',
};

const NODE_KEYS = new Set<string>(Object.values(ATTRIBUTE));

/**
 * `UIAccessibilityTraitNotEnabled`, the trait UIKit sets on a disabled control. The runner path
 * answers `enabled: false` for the same node, so the bridge derives the fact from this bit.
 */
const NOT_ENABLED_TRAIT = 1n << 8n;

/**
 * The selected-state trait the guest reader reports for a control the app marked selected — the
 * active tab in a tab bar, a chosen segment, a checked row. The runner path answers
 * `selected: true` for the same node, so the bridge derives the fact from this bit. A node that is
 * not selected omits the field, matching the runner, which publishes `selected` only when true.
 */
const SELECTED_TRAIT = 1n << 3n;

/**
 * A WebKit page — Safari's, or a `WKWebView`'s — lives in a WebContent process and reaches UIKit's
 * tree as an `AXRemoteElement` under the web view, with its children in that other process. The
 * guest reader snapshots one process, so it delivers that element as a leaf (#2484). Such a leaf
 * is opaque when it sits under a `WebView`-typed ancestor and its frame reaches the viewport: the
 * page is on screen and the tree does not describe it. A leaf whose frame is zero-area or off
 * screen hosts nothing the capture can miss; one that reports no frame at all is refused, because
 * nothing proves it is empty. Remote elements outside a web view are not classified here — no
 * capture has shown one — and content truncated away above the web view stays disclosed as
 * truncation, not as a boundary.
 */
const REMOTE_ELEMENT_CLASS = 'AXRemoteElement';
const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };
const WEB_VIEW_TYPE = 'WebView';

export function decodeSnapshotBridgeTree(
  tree: unknown,
  envelope: Readonly<{ truncated: unknown }>,
  limits: SnapshotSourceLimits,
): SnapshotSourceDecodedTree {
  const roots = Array.isArray(tree) ? tree : [tree];
  if (roots.length === 0 || roots.some((root) => !isRecord(root))) {
    throw snapshotSourceError('malformed-tree', 'guest-tree-root-invalid');
  }
  const nodes: RawSnapshotNode[] = [];
  const webHostedRemoteLeaves: (Rect | undefined)[] = [];
  let maxTraversalDepth = 0;
  for (const root of roots) {
    visitNode(root, undefined, 0, false);
  }
  if (nodes.length > limits.maxNodes) {
    throw snapshotSourceError('malformed-tree', 'node-limit-exceeded', {
      nodeCount: nodes.length,
      maxNodes: limits.maxNodes,
    });
  }
  if (maxTraversalDepth > limits.maxTraversalDepth) {
    throw snapshotSourceError('malformed-tree', 'traversal-depth-exceeded', {
      maxTraversalDepth,
      maxAllowedDepth: limits.maxTraversalDepth,
    });
  }
  if (typeof envelope.truncated !== 'boolean') {
    throw snapshotSourceError('malformed-tree', 'truncated-invalid');
  }
  const windowRoots = nodes.filter(isWindowRoot);
  const viewport = viewportFromRoot(windowRoots[0]);
  // The runner publishes `hittable` for every node as geometric actionability; the guest hands over no
  // hit-test result, so derive the same fact here from enabled + the node's own frame + the reported
  // viewport. Publishing it on the raw nodes (rather than in the fold) is what lets `snapshot --raw`
  // match the runner too, and it is only claimed once every input the rule needs is established — the
  // reported viewport, with unresolved coordinate-space windows already refused above.
  if (viewport.kind === 'reported') {
    publishDerivedHittability(nodes, viewport.rect);
  }
  return {
    nodes,
    maxTraversalDepth,
    viewport,
    opaqueRemoteElements: webHostedRemoteLeaves.filter((rect) => isOpaqueRemoteLeaf(rect, viewport))
      .length,
    unresolvedCoordinateSpaceWindows: countUnresolvedCoordinateSpaceWindows(nodes, viewport),
  };

  function visitNode(
    value: Record<string, unknown>,
    parentIndex: number | undefined,
    depth: number,
    underWebView: boolean,
  ): void {
    if (nodes.length >= limits.maxNodes) {
      throw snapshotSourceError('malformed-tree', 'node-limit-exceeded', {
        maxNodes: limits.maxNodes,
      });
    }
    for (const key of Object.keys(value)) {
      if (!NODE_KEYS.has(key)) {
        throw snapshotSourceError('malformed-tree', 'node-contains-unknown-field', { key });
      }
    }
    const children = value[ATTRIBUTE.children];
    if (!Array.isArray(children)) {
      throw snapshotSourceError('malformed-tree', 'children-invalid');
    }
    const index = nodes.length;
    const node = nodeFacts(value, index, parentIndex, depth);
    nodes.push(node);
    maxTraversalDepth = Math.max(maxTraversalDepth, depth);
    if (isWebHostedRemoteLeaf(node, children.length, underWebView)) {
      webHostedRemoteLeaves.push(node.rect);
    }
    const hostsWeb = underWebView || node.type === WEB_VIEW_TYPE;
    for (const child of children) {
      if (!isRecord(child)) throw snapshotSourceError('malformed-tree', 'child-invalid');
      visitNode(child, index, depth + 1, hostsWeb);
    }
  }
}

// fallow-ignore-next-line complexity
function nodeFacts(
  value: Record<string, unknown>,
  index: number,
  parentIndex: number | undefined,
  depth: number,
): RawSnapshotNode {
  const elementClass = optionalString(value[ATTRIBUTE.elementType]);
  const baseClass = optionalString(value[ATTRIBUTE.elementBaseType]);
  const automationType = optionalInteger(value[ATTRIBUTE.automationType]);
  const frame = frameFromGuest(value[ATTRIBUTE.frame]);
  const traits = traitsFromGuest(value[ATTRIBUTE.traits]);
  const enabled = traits === undefined ? undefined : (traits & NOT_ENABLED_TRAIT) === 0n;
  // Publishes `selected: true` only when the selected bit is set and omits it otherwise — the same
  // shape the XCTest tree produces, so a `selected:` selector cannot tell the producers apart.
  const selected = traits === undefined || (traits & SELECTED_TRAIT) === 0n ? undefined : true;
  const userInteractionEnabled = optionalBoolean(value[ATTRIBUTE.userInteractionEnabled]);
  // Trimmed like the runner's `placeholderText`: a whitespace placeholder is no placeholder.
  const placeholder = optionalString(value[ATTRIBUTE.placeholder])?.trim();
  return {
    index,
    ...(parentIndex === undefined ? {} : { parentIndex }),
    ...(elementTypeName(elementClass, automationType)
      ? { type: elementTypeName(elementClass, automationType) }
      : {}),
    ...(elementClass ? { role: elementClass } : {}),
    ...(baseClass && baseClass !== elementClass ? { subrole: baseClass } : {}),
    ...(optionalString(value[ATTRIBUTE.label])
      ? { label: optionalString(value[ATTRIBUTE.label]) }
      : {}),
    ...(optionalScalar(value[ATTRIBUTE.value])
      ? { value: optionalScalar(value[ATTRIBUTE.value]) }
      : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(optionalString(value[ATTRIBUTE.identifier])
      ? { identifier: optionalString(value[ATTRIBUTE.identifier]) }
      : {}),
    ...(frame ? { rect: frame } : {}),
    ...(enabled === undefined ? {} : { enabled }),
    ...(selected === undefined ? {} : { selected }),
    ...(userInteractionEnabled === undefined ? {} : { userInteractionEnabled }),
    depth,
  };
}

function elementTypeName(
  elementClass: string | undefined,
  automationType: number | undefined,
): string | undefined {
  if (elementClass !== undefined && CLASS_PROMOTED_TYPES[elementClass]) {
    return CLASS_PROMOTED_TYPES[elementClass];
  }
  if (elementClass !== undefined && ELEMENT_TYPE_NAMES.includes(elementClass)) {
    return elementClass;
  }
  if (automationType === undefined) return undefined;
  return ELEMENT_TYPE_NAMES[automationType] ?? 'Other';
}

function isWebHostedRemoteLeaf(
  node: RawSnapshotNode,
  childCount: number,
  underWebView: boolean,
): boolean {
  return underWebView && node.role === REMOTE_ELEMENT_CLASS && childCount === 0;
}

function isOpaqueRemoteLeaf(rect: Rect | undefined, viewport: IosViewportEvidence): boolean {
  if (rect === undefined) return true;
  if (!isPositiveFiniteRect(rect)) return false;
  return viewport.kind !== 'reported' || isRectVisibleInViewport(rect, viewport.rect);
}

function frameFromGuest(value: unknown): Rect | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw snapshotSourceError('malformed-tree', 'frame-invalid');
  const numbers = ['X', 'Y', 'Width', 'Height'].map((key) => value[key]);
  if (!numbers.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    throw snapshotSourceError('malformed-tree', 'frame-invalid');
  }
  const [x, y, width, height] = numbers as [number, number, number, number];
  if (width < 0 || height < 0) throw snapshotSourceError('malformed-tree', 'frame-invalid');
  return { x, y, width, height };
}

function viewportFromRoot(root: RawSnapshotNode | undefined): IosViewportEvidence {
  if (!root || !isWindowRoot(root)) {
    return { kind: 'missing', reason: 'not-provided' };
  }
  if (isPositiveFiniteRect(root.rect)) return { kind: 'reported', rect: root.rect };
  return { kind: 'missing', reason: root.rect ? 'invalid' : 'not-provided' };
}

function isWindowRoot(node: RawSnapshotNode): boolean {
  return node.type === 'Application' || node.type === 'Window';
}

/**
 * Stamp geometric actionability onto every decoded node, mirroring the XCTest runner's Swift rule
 * (`parentIndex != nil && isGeometricallyActionable(enabled, frame, viewport)`). A root, a disabled
 * node, or one whose frame center falls outside the viewport is published `hittable: false`; the
 * fold's `available` branch then intersects this with the clipped-frame test exactly as it does for
 * the runner, so the two producers cannot be told apart.
 */
function publishDerivedHittability(nodes: RawSnapshotNode[], viewport: Rect): void {
  for (const node of nodes) {
    node.hittable =
      node.parentIndex !== undefined &&
      isGeometricallyActionable(node.enabled !== false, node.rect, viewport);
  }
}

/**
 * Surface hosts reporting their subtree in a space this capture cannot name.
 *
 * The reader hands over the app's windows as siblings under the app root, and the first of them is
 * the app's own frame. A surface host whose box is that frame quarter-turned is hosted in the device's
 * native space and every rect under it arrives turned with it (#2612); rotating it back needs the
 * app's interface orientation, which the reader's attribute set does not carry. Only a host declares a
 * space — the window, or the surface directly under it where the turn actually shows up — because a
 * deep node reporting large bounds is content, not a hosted surface. The count is a refusal signal
 * rather than a repair: the route serves the capture from the runner, which reads the orientation and
 * publishes one space. Detection is deliberately symmetric — reading the turned surface as the app
 * frame flags the app's own window instead — so an unexpected window order still refuses rather than
 * publishing half a screen.
 */
function countUnresolvedCoordinateSpaceWindows(
  nodes: readonly RawSnapshotNode[],
  viewport: IosViewportEvidence,
): number {
  if (viewport.kind !== 'reported') return 0;
  return nodes.filter(
    (node) =>
      isSurfaceHost(node, nodes) &&
      isQuarterTurnedWindowFrame(node.rect ?? EMPTY_RECT, viewport.rect),
  ).length;
}

/** The window itself, or the surface directly under it: where a hosted surface's box appears. */
function isSurfaceHost(node: RawSnapshotNode, nodes: readonly RawSnapshotNode[]): boolean {
  if (isWindowRoot(node)) return true;
  return node.parentIndex === undefined ? false : isWindowRoot(nodes[node.parentIndex] ?? node);
}

// fallow-ignore-next-line code-duplication
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalScalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value !== undefined && value !== null) {
    throw snapshotSourceError('malformed-tree', 'scalar-invalid');
  }
  return undefined;
}

/**
 * The guest sends the uint64 traits word as a decimal string so no bit is lost to a double. One
 * parse feeds every trait fact the tree publishes — `enabled` and `selected` — so a malformed word
 * fails the same way no matter which fact is read.
 */
function traitsFromGuest(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) {
    throw snapshotSourceError('malformed-tree', 'traits-invalid');
  }
  return BigInt(value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw snapshotSourceError('malformed-tree', 'user-interaction-invalid');
  }
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value))
    throw snapshotSourceError('malformed-tree', 'automation-type-invalid');
  return value as number;
}
