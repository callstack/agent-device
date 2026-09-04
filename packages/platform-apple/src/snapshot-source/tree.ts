import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import type { IosViewportEvidence } from '@agent-device/contracts/ios-snapshot';
import { snapshotSourceError } from './errors.ts';
import type { SnapshotSourceDecodedTree, SnapshotSourceLimits } from './types.ts';
import { isRecord } from './protocol.ts';

// fallow-ignore-next-line code-duplication
const ATTRIBUTE = Object.freeze({
  elementType: 'XC_kAXXCAttributeElementType',
  elementBaseType: 'XC_kAXXCAttributeElementBaseType',
  label: 'XC_kAXXCAttributeLabel',
  value: 'XC_kAXXCAttributeValue',
  identifier: 'XC_kAXXCAttributeIdentifier',
  frame: 'XC_kAXXCAttributeFrame',
  automationType: 'XC_kAXXCAttributeAutomationType',
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
  let maxTraversalDepth = 0;
  for (const root of roots) {
    visitNode(root, undefined, 0);
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
  return {
    nodes,
    maxTraversalDepth,
    viewport: viewportFromRoot(
      nodes.find((node) => node.type === 'Application' || node.type === 'Window'),
    ),
  };

  function visitNode(
    value: Record<string, unknown>,
    parentIndex: number | undefined,
    depth: number,
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
    for (const child of children) {
      if (!isRecord(child)) throw snapshotSourceError('malformed-tree', 'child-invalid');
      visitNode(child, index, depth + 1);
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
    ...(optionalString(value[ATTRIBUTE.identifier])
      ? { identifier: optionalString(value[ATTRIBUTE.identifier]) }
      : {}),
    ...(frame ? { rect: frame } : {}),
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
  if (!root || (root.type !== 'Application' && root.type !== 'Window')) {
    return { kind: 'missing', reason: 'not-provided' };
  }
  if (isPositiveFiniteRect(root.rect)) return { kind: 'reported', rect: root.rect };
  return { kind: 'missing', reason: root.rect ? 'invalid' : 'not-provided' };
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

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value))
    throw snapshotSourceError('malformed-tree', 'automation-type-invalid');
  return value as number;
}
