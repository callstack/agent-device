import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import type {
  IosAcquisitionResidue,
  IosProviderAcquisitionCapabilities,
  IosProviderAcquisitionProducer,
  IosSnapshotEvidenceAvailability,
  IosSnapshotLineage,
  IosSnapshotProducer,
  IosViewportEvidence,
} from '@agent-device/contracts/ios-snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type {
  IosValueSemantics,
  RawSnapshotNode,
  Rect,
  SnapshotKeyboardBandFact,
} from '@agent-device/kernel/snapshot';

/**
 * The facts a *provider* acquisition leaves unproven, keyed only by the producers whose residue
 * this module derives.
 *
 * `apple-runner` and `simulator-ax-bridge` are absent by construction, not by omission: each
 * builds its own residue at the source (the bridge reader derives geometric `hittable` onto its
 * nodes and emits `unavailable-fact: hittability` only when the viewport is missing; the runner
 * presents and reports its own facts), so a row here would be a declaration with no reader — which
 * is how the table once came to claim the bridge had hittability evidence while every bridge-served
 * `snapshot -i` printed the opposite (#2199). Keying the record on
 * {@link IosProviderAcquisitionProducer} makes that claim not compile.
 */
const IOS_PROVIDER_ACQUISITION_CAPABILITY_VALUES = {
  'appium-source': {
    producer: 'appium-source',
    acquisitionDepth: {
      rawTraversal: { kind: 'incomplete' },
      regularPresented: { kind: 'incomplete' },
    },
    hittabilityEvidence: 'unavailable',
  },
  'limrun-ios-tree': {
    producer: 'limrun-ios-tree',
    acquisitionDepth: {
      rawTraversal: { kind: 'incomplete' },
      regularPresented: { kind: 'incomplete' },
    },
    hittabilityEvidence: 'unavailable',
  },
} as const satisfies Record<IosProviderAcquisitionProducer, IosProviderAcquisitionCapabilities>;

/**
 * Whether a producer observes truncation at all, for every iOS producer.
 *
 * This is the one capability the runner and the bridge genuinely need declared: a capture that
 * reported nothing about truncation is only "not truncated" when its producer would have noticed
 * (#2188 invariant 5), and `snapshotTruncationForResult` has to answer that for all four. It is a
 * table of its own rather than a column of the provider capabilities so that each producer states
 * this fact exactly once, in the only place that asks.
 *
 * The runner payload carries a required `truncated` boolean, and the bridge adapter rejects an
 * envelope without one and turns a true into a `truncated` residue — so both observe it.
 */
const IOS_SNAPSHOT_TRUNCATION_EVIDENCE = {
  'apple-runner': 'available',
  'simulator-ax-bridge': 'available',
  'appium-source': 'unavailable',
  'limrun-ios-tree': 'unavailable',
} as const satisfies Record<IosSnapshotProducer, IosSnapshotEvidenceAvailability>;

export function iosSnapshotTruncationEvidence(
  producer: IosSnapshotProducer,
): IosSnapshotEvidenceAvailability {
  return IOS_SNAPSHOT_TRUNCATION_EVIDENCE[producer];
}

function deriveIosSnapshotAcquisitionResidue(
  producer: IosProviderAcquisitionCapabilities,
  viewport: IosViewportEvidence,
): readonly IosAcquisitionResidue[] {
  const residue: IosAcquisitionResidue[] = [];
  if (producer.hittabilityEvidence === 'unavailable') {
    residue.push({ kind: 'unavailable-fact', fact: 'hittability' });
  }
  if (
    producer.acquisitionDepth.rawTraversal.kind === 'incomplete' ||
    producer.acquisitionDepth.regularPresented.kind === 'incomplete'
  ) {
    residue.push({ kind: 'unavailable-fact', fact: 'acquisition-depth' });
  }
  if (iosSnapshotTruncationEvidence(producer.producer) === 'unavailable') {
    residue.push({ kind: 'unavailable-fact', fact: 'truncation' });
  }
  if (viewport.kind === 'missing') {
    residue.push({ kind: 'missing-viewport', reason: viewport.reason });
  }
  return Object.freeze(residue);
}

export function createIosSnapshotAcquisition(
  input: Readonly<{
    producer: IosProviderAcquisitionProducer;
    nodes: readonly RawSnapshotNode[];
    viewport: IosViewportEvidence;
    keyboard?: SnapshotKeyboardBandFact;
    lineage: IosSnapshotLineage;
  }>,
): SnapshotRuntimeAcquiredResult {
  const producer = IOS_PROVIDER_ACQUISITION_CAPABILITY_VALUES[input.producer];
  return {
    stage: 'acquired',
    acquisition: {
      producer: input.producer,
      intent: 'full',
      nodes: input.nodes.map((node) => interpretIosNode(node)),
      viewport: input.viewport,
      ...(input.keyboard ? { keyboard: input.keyboard } : {}),
      lineage: input.lineage,
      residue: deriveIosSnapshotAcquisitionResidue(producer, input.viewport),
    },
  };
}

type IosSnapshotViewportRoot = Readonly<{
  type?: string;
  rect?: Rect;
  rectStatus?: 'reported' | 'invalid' | 'not-provided';
}>;

export function resolveIosViewportEvidenceFromRoots(
  roots: readonly IosSnapshotViewportRoot[],
  options: Readonly<{ fallbackToLargestRoot?: boolean }> = {},
): IosViewportEvidence | undefined {
  const viewportRoots = roots.filter(isViewportRoot);
  const candidates =
    viewportRoots.length > 0 || options.fallbackToLargestRoot !== true ? viewportRoots : roots;
  const root = [...candidates].sort(compareViewportRoots)[0];
  if (!root) return undefined;
  if (isPositiveFiniteRect(root.rect)) return { kind: 'reported', rect: root.rect };
  return {
    kind: 'missing',
    reason:
      root.rectStatus === 'invalid' || (root.rectStatus === undefined && root.rect !== undefined)
        ? 'invalid'
        : 'not-provided',
  };
}

function isViewportRoot(root: IosSnapshotViewportRoot): boolean {
  const type = normalizeType(root.type ?? '');
  return type === 'application' || type === 'window';
}

function compareViewportRoots(
  left: IosSnapshotViewportRoot,
  right: IosSnapshotViewportRoot,
): number {
  const status = rootGeometryRank(right.rectStatus) - rootGeometryRank(left.rectStatus);
  return status || rectArea(right.rect) - rectArea(left.rect);
}

function rootGeometryRank(status: IosSnapshotViewportRoot['rectStatus']): number {
  return status === 'reported' ? 2 : status === 'invalid' ? 1 : 0;
}

function rectArea(rect: Rect | undefined): number {
  return rect && isPositiveFiniteRect(rect) ? rect.width * rect.height : 0;
}

/** Acquires native iOS type/value facts and RN value semantics without overriding producer facts. */
export function interpretIosNode(
  node: RawSnapshotNode,
  options: Readonly<{ reactNativeValue?: boolean }> = {},
): RawSnapshotNode {
  const type = node.type?.replace(/^XCUIElementType/, '');
  const field = ['TextField', 'SecureTextField', 'SearchField', 'TextView'].includes(type ?? '');
  const checkable = ['Switch', 'CheckBox', 'RadioButton', 'Toggle'].includes(type ?? '');
  const facts: Pick<RawSnapshotNode, 'checked' | 'password' | 'editable'> = {};
  if (checkable && node.checked === undefined) {
    const checked = nativeCheckedValue(node.value);
    if (checked !== undefined) facts.checked = checked;
  }
  if (field) {
    if (node.password === undefined) facts.password = type === 'SecureTextField';
    if (node.editable === undefined) facts.editable = true;
  }
  const interpreted = Object.keys(facts).length === 0 ? node : { ...node, ...facts };
  return options.reactNativeValue === false ? interpreted : interpretReactNativeValue(interpreted);
}

function nativeCheckedValue(value: string | undefined): boolean | undefined {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

const RN_VIEW_CLASSES = new Set(['RCTView', 'RCTViewComponentView']);
const ENGLISH_ROLES: Readonly<Record<string, string>> = {
  alert: 'alert',
  checkbox: 'checkbox',
  'combo box': 'combobox',
  menu: 'menu',
  'menu bar': 'menubar',
  'menu item': 'menuitem',
  'progress bar': 'progressbar',
  'radio button': 'radio',
  'radio group': 'radiogroup',
  'scroll bar': 'scrollbar',
  'spin button': 'spinbutton',
  switch: 'switch',
  tab: 'tab',
  'tab list': 'tablist',
  timer: 'timer',
  'tool bar': 'toolbar',
};

type StateComponent = Pick<IosValueSemantics, 'checked' | 'expanded' | 'busy'>;
const ENGLISH_STATES: Readonly<Record<string, StateComponent>> = {
  checked: { checked: true },
  unchecked: { checked: false },
  mixed: { checked: 'mixed' },
  expanded: { expanded: true },
  collapsed: { expanded: false },
  busy: { busy: true },
};

/** Interprets RN's value grammar without removing value evidence or overriding native facts. */
function interpretReactNativeValue(node: RawSnapshotNode): RawSnapshotNode {
  if (node.iosValueSemantics || typeof node.value !== 'string') return node;
  if (!isInterpretationCandidate(node)) return node;
  const semantics = parseEnglishValue(node.value, node.role);
  if (!semantics || !hasSupportedSignature(node, semantics)) return node;
  return {
    ...node,
    iosValueSemantics: semantics,
    ...(node.checked === undefined && typeof semantics.checked === 'boolean'
      ? { checked: semantics.checked }
      : {}),
  };
}

function isInterpretationCandidate(node: RawSnapshotNode): boolean {
  if (normalizeType(node.type ?? '') !== 'other' || node.editable || node.password) return false;
  if (RN_VIEW_CLASSES.has(node.role ?? '')) return true;
  return node.role === undefined || normalizeType(node.role) === 'other';
}

function hasSupportedSignature(node: RawSnapshotNode, semantics: IosValueSemantics): boolean {
  const checkableRole = semantics.role === 'checkbox' || semantics.role === 'radio';
  if (semantics.role !== undefined && !checkableRole && node.role !== 'RCTView') return false;
  if (RN_VIEW_CLASSES.has(node.role ?? '')) return true;
  return checkableRole && semantics.checked !== undefined;
}

function parseEnglishValue(
  value: string,
  nativeClass: string | undefined,
): IosValueSemantics | undefined {
  const components = value.split(', ');
  const first = components[0] ?? '';
  const role = Object.hasOwn(ENGLISH_ROLES, first) ? ENGLISH_ROLES[first] : undefined;
  const semantics: IosValueSemantics = {
    source: 'react-native-ios-value-heuristic',
    encoding: 'en',
    ...(role === undefined ? {} : { role }),
  };
  let lastStateOrder = 0;
  for (const component of components.slice(role === undefined ? 0 : 1)) {
    if (!Object.hasOwn(ENGLISH_STATES, component)) break;
    const state = ENGLISH_STATES[component]!;
    if (Object.keys(state).some((key) => Object.hasOwn(semantics, key))) break;
    const stateOrder = fabricStateOrder(state);
    if (nativeClass === 'RCTViewComponentView' && stateOrder < lastStateOrder) break;
    lastStateOrder = stateOrder;
    Object.assign(semantics, state);
  }
  return semantics.role !== undefined ||
    semantics.checked !== undefined ||
    semantics.expanded !== undefined ||
    semantics.busy !== undefined
    ? semantics
    : undefined;
}

function fabricStateOrder(state: StateComponent): number {
  if (state.checked !== undefined) return 1;
  if (state.expanded !== undefined) return 2;
  return 3;
}
