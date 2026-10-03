import type {
  RawAcquiredNode,
  RawAcquisition,
  ResourceLimits,
  SpikeFailure,
  SpikeRequest,
} from './types.ts';

/**
 * Host side of the guest `accessibility serve` wire contract, byte-matching
 * `SimulatorFrameworkBridge/AccessibilityService.m` in idb v1.5.2: frames are a 4-byte big-endian
 * length prefix followed by one JSON object; the guest answers `{ ok, tree | error, error_kind, pid,
 * truncated, phases, automation }`.
 */
const GUEST_FRAME_HEADER_BYTES = 4;
const GUEST_MAX_FRAME_BYTES = 16 * 1024 * 1024;

const ATTRIBUTE = {
  elementType: 'XC_kAXXCAttributeElementType',
  elementBaseType: 'XC_kAXXCAttributeElementBaseType',
  label: 'XC_kAXXCAttributeLabel',
  value: 'XC_kAXXCAttributeValue',
  identifier: 'XC_kAXXCAttributeIdentifier',
  frame: 'XC_kAXXCAttributeFrame',
  automationType: 'XC_kAXXCAttributeAutomationType',
  children: 'XC_kAXXCAttributeChildren',
} as const;

/** `XCUIElementType` raw values, from Xcode's `XCUIElementTypes.h`; `Any` reads as `Other`. */
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

/**
 * XCTest names the application and window elements by class rather than by automation type; the
 * XCTest control tree reports `Application`/`Window` where the guest attribute says 1/2. Observed
 * node-for-node against the control on the catalog fixture (279/279 aligned).
 */
const CLASS_PROMOTED_TYPES: Readonly<Record<string, string>> = {
  UIApplication: 'Application',
  UIWindow: 'Window',
};

export type GuestEnvelope = Readonly<Record<string, unknown>>;

export type GuestErrorKind =
  | 'application_unavailable'
  | 'application_not_responding'
  | 'frontmost_unresolved'
  | 'reader_unavailable'
  | 'bad_request'
  | 'assertion_failed';

export function encodeGuestFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.alloc(GUEST_FRAME_HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Reassembles length-prefixed frames from a byte stream; oversize frames throw. */
export class GuestFrameDecoder {
  private buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = GUEST_MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    while (this.buffer.length >= GUEST_FRAME_HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > this.maxFrameBytes) {
        throw new GuestWireError('malformed-tree', 'frame-limit-exceeded');
      }
      if (this.buffer.length < GUEST_FRAME_HEADER_BYTES + length) break;
      frames.push(
        this.buffer.subarray(GUEST_FRAME_HEADER_BYTES, GUEST_FRAME_HEADER_BYTES + length),
      );
      this.buffer = this.buffer.subarray(GUEST_FRAME_HEADER_BYTES + length);
    }
    return frames;
  }
}

export class GuestWireError extends Error {
  readonly kind: SpikeFailure['kind'];
  readonly code: string;

  constructor(kind: SpikeFailure['kind'], code: string) {
    super(`${kind}/${code}`);
    this.name = 'GuestWireError';
    this.kind = kind;
    this.code = code;
  }
}

export function parseExpectedPid(generation: string | undefined): number | undefined {
  if (!generation?.startsWith('pid:')) return undefined;
  const pid = Number(generation.slice('pid:'.length).split(':', 1)[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * The guest `describe` request for one spike request. A known target generation names the app by
 * pid; otherwise the guest resolves the foreground app in-guest through RunningBoard (the anchor is
 * required by the wire even when the method ignores it). Automation mode is asserted on every read so
 * the target exposes its accessibility server without preboot preference edits; the single-fetch
 * traversal keeps one Mach round trip per read.
 */
export function guestDescribeRequest(
  request: SpikeRequest,
  limits: ResourceLimits,
): Record<string, unknown> {
  const pid = parseExpectedPid(request.expectedTargetGeneration);
  return {
    verb: 'describe',
    ...(pid === undefined ? { x: 1, y: 1, method: 'runningboard' } : { pid }),
    snapshotTree: true,
    automationMode: true,
    maxDepth: limits.maxTraversalDepth,
    maxNodes: limits.maxNodes,
  };
}

function guestErrorKind(envelope: GuestEnvelope): GuestErrorKind | undefined {
  const kind = envelope.error_kind;
  return typeof kind === 'string' ? (kind as GuestErrorKind) : undefined;
}

function guestErrorText(envelope: GuestEnvelope): string {
  return typeof envelope.error === 'string' ? envelope.error : '';
}

/**
 * Whether a failed read is the target's accessibility server not being reachable yet, which is what
 * a freshly launched app (or one whose automation mode was just asserted) reports for a moment.
 */
export function isTargetNotReady(envelope: GuestEnvelope): boolean {
  return (
    guestErrorKind(envelope) === 'application_unavailable' ||
    guestErrorText(envelope).includes('kAXErrorServerNotFound')
  );
}

export function failureFromEnvelope(
  envelope: GuestEnvelope,
  request: SpikeRequest,
  targetAlive: (pid: number) => boolean,
): SpikeFailure {
  const expectedPid = parseExpectedPid(request.expectedTargetGeneration);
  const kind = guestErrorKind(envelope);
  const targetSymptom =
    kind === 'application_unavailable' ||
    kind === 'application_not_responding' ||
    isTargetNotReady(envelope);
  // The expected generation is provably gone: whatever symptom the guest saw while reaching for the
  // dead pid, the honest answer is a stale generation, never a timeout the caller might retry.
  if (targetSymptom && expectedPid !== undefined && !targetAlive(expectedPid)) {
    return {
      kind: 'stale-generation',
      code: 'target-generation-mismatch',
      expectedTargetGeneration: request.expectedTargetGeneration!,
    };
  }
  if (isTargetNotReady(envelope)) {
    return { kind: 'transport-failure', code: 'target-application-unavailable' };
  }
  switch (kind) {
    case 'application_unavailable':
      return { kind: 'transport-failure', code: 'target-application-unavailable' };
    case 'application_not_responding':
      return { kind: 'timeout', code: 'application-not-responding' };
    case 'frontmost_unresolved':
      return { kind: 'transport-failure', code: 'frontmost-unresolved' };
    case 'reader_unavailable':
      return { kind: 'unsupported-mechanism', code: 'reader-unavailable' };
    case 'bad_request':
      return { kind: 'transport-failure', code: 'bad-request' };
    default:
      return { kind: 'transport-failure', code: 'guest-error' };
  }
}

export type GuestAcquisition = Readonly<{
  acquisition: RawAcquisition;
  observedPid: number | undefined;
}>;

export function acquisitionFromEnvelope(
  envelope: GuestEnvelope,
  request: SpikeRequest,
  limits: ResourceLimits,
): GuestAcquisition | SpikeFailure {
  const expectedPid = parseExpectedPid(request.expectedTargetGeneration);
  const observedPid = typeof envelope.pid === 'number' ? envelope.pid : undefined;
  if (expectedPid !== undefined && observedPid !== undefined && observedPid !== expectedPid) {
    return {
      kind: 'stale-generation',
      code: 'target-generation-mismatch',
      expectedTargetGeneration: request.expectedTargetGeneration!,
      observedTargetGeneration: `pid:${observedPid}`,
    };
  }
  const roots = guestRoots(envelope.tree);
  if (!roots) return { kind: 'malformed-tree', code: 'guest-tree-shape' };
  const nodes = flattenGuestTree(roots);
  const truncated = envelope.truncated === true;
  const pid = expectedPid ?? observedPid;
  const viewport = viewportFromRoot(roots[0]);
  return {
    observedPid,
    acquisition: {
      targetId: `simulator:${request.simulatorUdid}`,
      targetGeneration: pid === undefined ? null : `pid:${pid}`,
      nodes,
      viewport,
      truncated,
      residue: [
        ...(truncated ? [truncationResidue(nodes.length, limits)] : []),
        ...(pid === undefined ? [{ kind: 'unavailable-fact', fact: 'generation' } as const] : []),
      ],
    },
  };
}

function truncationResidue(
  nodeCount: number,
  limits: ResourceLimits,
): RawAcquisition['residue'][number] {
  return nodeCount >= limits.maxNodes
    ? { kind: 'truncated', dimension: 'nodes', limit: limits.maxNodes }
    : {
        kind: 'truncated',
        dimension: 'depth',
        limit: limits.maxTraversalDepth,
      };
}

function guestRoots(tree: unknown): Record<string, unknown>[] | undefined {
  if (Array.isArray(tree)) return tree.every(isRecord) ? tree : undefined;
  return isRecord(tree) ? [tree] : undefined;
}

/** Depth-first flattening; ids follow traversal order and parents precede children. */
export function flattenGuestTree(roots: readonly Record<string, unknown>[]): RawAcquiredNode[] {
  const nodes: RawAcquiredNode[] = [];
  const visit = (element: Record<string, unknown>, parentId: string | undefined): void => {
    const id = `n${nodes.length}`;
    nodes.push({
      id,
      ...(parentId === undefined ? {} : { parentId }),
      ...nodeFacts(element),
    });
    const children = element[ATTRIBUTE.children];
    if (!Array.isArray(children)) return;
    for (const child of children) if (isRecord(child)) visit(child, id);
  };
  for (const root of roots) visit(root, undefined);
  return nodes;
}

function nodeFacts(element: Record<string, unknown>): Omit<RawAcquiredNode, 'id' | 'parentId'> {
  const elementClass = optionalString(element[ATTRIBUTE.elementType]);
  const baseClass = optionalString(element[ATTRIBUTE.elementBaseType]);
  const type = elementTypeName(elementClass, element[ATTRIBUTE.automationType]);
  const label = optionalString(element[ATTRIBUTE.label]);
  const value = optionalScalar(element[ATTRIBUTE.value]);
  const identifier = optionalString(element[ATTRIBUTE.identifier]);
  const frame = frameFromGuest(element[ATTRIBUTE.frame]);
  return {
    ...(type === undefined ? {} : { type }),
    ...(elementClass === undefined ? {} : { role: elementClass }),
    ...(baseClass === undefined || baseClass === elementClass ? {} : { subrole: baseClass }),
    ...(label === undefined ? {} : { label }),
    ...(value === undefined ? {} : { value }),
    ...(identifier === undefined ? {} : { identifier }),
    ...(frame === undefined ? {} : { frame }),
  };
}

export function elementTypeName(
  elementClass: string | undefined,
  automationType: unknown,
): string | undefined {
  if (elementClass !== undefined && CLASS_PROMOTED_TYPES[elementClass]) {
    return CLASS_PROMOTED_TYPES[elementClass];
  }
  if (typeof automationType !== 'number' || !Number.isInteger(automationType)) return undefined;
  return ELEMENT_TYPE_NAMES[automationType] ?? 'Other';
}

function frameFromGuest(value: unknown): RawAcquiredNode['frame'] | undefined {
  if (!isRecord(value)) return undefined;
  const numbers = ['X', 'Y', 'Width', 'Height'].map((key) => value[key]);
  if (!numbers.every((number) => typeof number === 'number' && Number.isFinite(number))) {
    return undefined;
  }
  const [x, y, width, height] = numbers as [number, number, number, number];
  return { x, y, width, height };
}

function viewportFromRoot(root: Record<string, unknown> | undefined): RawAcquisition['viewport'] {
  const frame = root === undefined ? undefined : frameFromGuest(root[ATTRIBUTE.frame]);
  const isApplication =
    root !== undefined && optionalString(root[ATTRIBUTE.elementType]) === 'UIApplication';
  return isApplication && frame
    ? { kind: 'reported', rect: frame }
    : { kind: 'missing', reason: 'not-provided' };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalScalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
