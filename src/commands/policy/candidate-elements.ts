import type { PolicyCandidate } from './policy-contract.ts';

/**
 * The snapshot fields the policy projection reads. Kept structural rather than importing the
 * presented-node type so the projection can be unit-tested from literals.
 */
export type PolicySnapshotNode = {
  index?: number;
  parentIndex?: number;
  type?: string;
  label?: string;
  value?: string;
  identifier?: string;
  enabled?: boolean;
  ref?: string;
};

/** Node types that are actionable in themselves. */
const LEAF_ROLES: Record<string, string> = {
  Button: 'button',
  TextField: 'textfield',
  SecureTextField: 'textfield',
  TextView: 'textfield',
  Switch: 'switch',
  Link: 'link',
  Slider: 'slider',
  Key: 'key',
  CheckBox: 'checkbox',
  RadioButton: 'radio',
  MenuItem: 'menuitem',
};

/** Container types that carry no decision value of their own. */
const STRUCTURAL_TYPES = new Set([
  'Application',
  'Window',
  'Other',
  'CollectionView',
  'ScrollView',
  'Table',
  'NavigationBar',
  'Group',
]);

const TEXT_ROLE = 'text';

/** Roles whose value is text the caller can write. */
export function isTextEntryRole(role: string): boolean {
  return role === 'textfield';
}

/**
 * Project a snapshot into the candidate set a policy chooses between.
 *
 * A list cell that wraps an actionable leaf is dropped in favour of the leaf, so the policy never
 * has to choose between a row and the button inside it. Static text stays as `text` context: it is
 * what distinguishes "Enter the code" from "Welcome" when every button on both screens is generic.
 */
export function toPolicyCandidates(nodes: readonly PolicySnapshotNode[]): PolicyCandidate[] {
  const childrenOf = new Map<number, PolicySnapshotNode[]>();
  for (const node of nodes) {
    if (node.parentIndex === undefined) continue;
    const siblings = childrenOf.get(node.parentIndex);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parentIndex, [node]);
  }

  const candidates: PolicyCandidate[] = [];
  for (const node of nodes) {
    const type = node.type ?? '';
    if (!node.ref || STRUCTURAL_TYPES.has(type)) continue;

    let role: string;
    if (LEAF_ROLES[type]) {
      role = LEAF_ROLES[type];
    } else if (type === 'Cell') {
      if (node.index !== undefined && hasActionableDescendant(childrenOf, node.index)) continue;
      role = 'button';
    } else if (type === 'StaticText') {
      role = TEXT_ROLE;
    } else {
      continue;
    }

    candidates.push({
      ref: node.ref.startsWith('@') ? node.ref : `@${node.ref}`,
      role,
      name: node.label || node.identifier || type,
      ...(node.identifier === undefined ? {} : { identifier: node.identifier }),
      ...(node.value === undefined ? {} : { value: node.value }),
      ...(node.enabled === false ? { disabled: true } : {}),
    });
  }
  return candidates;
}

/** The subset a policy may choose: actionable, enabled, and not plain text. */
export function selectableCandidates(candidates: readonly PolicyCandidate[]): PolicyCandidate[] {
  return candidates.filter(
    (candidate) => candidate.role !== TEXT_ROLE && candidate.disabled !== true,
  );
}

/**
 * A stable digest of what the screen shows, used to detect an action that changed nothing.
 * Refs are excluded on purpose: they are reissued per snapshot generation, so including them would
 * make every screen look changed.
 */
export function screenDigest(candidates: readonly PolicyCandidate[]): string {
  return candidates
    .map(
      (candidate) =>
        `${candidate.role}:${candidate.name}:${candidate.value ?? ''}:${candidate.disabled ? 'd' : ''}`,
    )
    .join('|');
}

/** A short label for logs and step records: the leading text plus the first few controls. */
export function screenLabel(candidates: readonly PolicyCandidate[]): string {
  const text = candidates.filter((candidate) => candidate.role === TEXT_ROLE).slice(0, 2);
  const controls = selectableCandidates(candidates)
    .filter((candidate) => candidate.role !== 'key')
    .slice(0, 3);
  const label = [...text, ...controls].map((candidate) => candidate.name).join(' | ');
  return label.length > 0 ? label.slice(0, 80) : '(no labelled elements)';
}

/** The keypad key that enters `digit`, when a numeric keypad is on screen. */
export function findKeypadDigit(
  nodes: readonly PolicySnapshotNode[],
  digit: string,
): PolicySnapshotNode | undefined {
  return nodes.find((node) => node.type === 'Key' && node.label === digit && Boolean(node.ref));
}

function hasActionableDescendant(
  childrenOf: ReadonlyMap<number, PolicySnapshotNode[]>,
  index: number,
): boolean {
  for (const child of childrenOf.get(index) ?? []) {
    if (child.type && LEAF_ROLES[child.type]) return true;
    if (child.index !== undefined && hasActionableDescendant(childrenOf, child.index)) return true;
  }
  return false;
}
