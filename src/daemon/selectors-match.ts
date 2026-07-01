import type { Platform, PublicPlatform } from '../kernel/device.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { isNodeEditable, isNodeVisible } from '../utils/selector-node.ts';
import { extractNodeText, normalizeType } from '../snapshot/snapshot-processing.ts';
import { normalizeText } from '../utils/finders.ts';
import type { Selector, SelectorTerm } from './selectors-parse.ts';

export { isNodeEditable, isNodeVisible } from '../utils/selector-node.ts';

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
      return textEquals(normalizeType(node.type ?? ''), String(term.value));
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
