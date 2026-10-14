import { normalizeType } from '@agent-device/contracts/snapshot';
import type { IosValueSemantics, RawSnapshotNode } from '@agent-device/kernel/snapshot';

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
export function interpretIosReactNativeValue(node: RawSnapshotNode): RawSnapshotNode {
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
