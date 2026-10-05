import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { isNodeEditable, isNodeVisible, roleSpellingsOfNode } from './node.ts';
import { extractNodeText } from '@agent-device/contracts/snapshot';
import { normalizeText } from './find.ts';
import type { Selector, SelectorTerm } from './parse.ts';

export function matchesSelector(
  node: SnapshotNode,
  selector: Selector,
  platform: Platform | PublicPlatform,
): boolean {
  return selector.terms.every((term) => matchesTerm(node, term, platform));
}

function matchesTerm(
  node: SnapshotNode,
  term: SelectorTerm,
  platform: Platform | PublicPlatform,
): boolean {
  switch (term.key) {
    case 'id':
      return textEquals(node.identifier, String(term.value));
    case 'role':
      return matchesRoleKind(node, String(term.value));
    case 'label':
      return textEquals(node.label, String(term.value));
    case 'value':
      return textEquals(node.value, String(term.value));
    case 'text':
      return textEquals(extractNodeText(node), String(term.value));
    case 'appname':
      return textEquals(node.appName, String(term.value));
    case 'windowtitle':
      return textEquals(node.windowTitle, String(term.value));
    case 'visible':
      return isNodeVisible(node) === Boolean(term.value);
    case 'hidden':
      return !isNodeVisible(node) === Boolean(term.value);
    case 'editable':
      return isNodeEditable(node, platform) === Boolean(term.value);
    case 'selected':
      return Boolean(node.selected === true) === Boolean(term.value);
    case 'focused':
      return Boolean(node.focused === true) === Boolean(term.value);
    case 'enabled':
      return Boolean(node.enabled !== false) === Boolean(term.value);
    case 'hittable':
      return Boolean(node.hittable === true) === Boolean(term.value);
    default:
      return false;
  }
}

function textEquals(value: string | undefined, query: string): boolean {
  return normalizeText(value ?? '') === normalizeText(query);
}

/**
 * `role=` matches the canonical `kind` vocabulary (#3021): a term value equals
 * the node's role kind, or one of the legacy spellings still windowed for that
 * node. Both come from {@link roleSpellingsOfNode} — the same `kind`
 * `attachRefs` publishes and the same `normalizeType` that RECORDS selector
 * chains — so the selector, the `find role=` locator, snapshot output, and
 * recorded scripts cannot disagree about a node's role.
 */
function matchesRoleKind(node: SnapshotNode, query: string): boolean {
  const normalizedQuery = normalizeText(query);
  return roleSpellingsOfNode(node).some((spelling) => normalizeText(spelling) === normalizedQuery);
}
