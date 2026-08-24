import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import {
  collectChildrenByParent,
  findNearestAncestor,
  mergeReplacement,
  type SnapshotTreeRuleContext,
} from '../tree.ts';

/**
 * WebKit exposes HTML text through an `Other -> StaticText` wrapper pair on iOS.
 * Keep the wrapper's stable tree position but project the semantic leaf role so
 * selectors and rendered snapshots do not describe ordinary text as "other".
 *
 * HTML headings use the same pair and expose their level as the wrapper value.
 * XCTest does not publish the level as a dedicated field, so the public role is
 * `Heading` while the backend-specific level remains available only in the raw
 * diagnostic node.
 */
export function collectIosWebSemanticPresentation(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  const childrenByParent = collectChildrenByParent(nodes);

  for (const node of nodes) {
    if (normalizeType(node.type ?? '') === 'element(58)') {
      mergeReplacement(context.replacements, node, { type: 'WebView' });
      continue;
    }
    const presentation = classifyIosWebTextWrapper(
      node,
      context.sourceNodesByIndex,
      childrenByParent,
    );
    if (presentation?.kind === 'suppress') {
      context.suppressNode(node, []);
      continue;
    }
    if (presentation) {
      mergeReplacement(context.replacements, node, {
        type: presentation.type,
        ...(presentation.type === 'Heading' ? { value: undefined } : {}),
      });
      context.semanticRepresentativeIndexes.add(node.index);
    }
  }
}

type IosWebTextWrapperPresentation =
  | { kind: 'semantic'; type: 'Heading' | 'StaticText' }
  | { kind: 'suppress' };

function classifyIosWebTextWrapper(
  node: RawSnapshotNode,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
  childrenByParent: ReadonlyMap<number, RawSnapshotNode[]>,
): IosWebTextWrapperPresentation | null {
  if (normalizeType(node.type ?? '') !== 'other') return null;
  const webView = findNearestAncestor(node, byIndex, isWebView);
  const label = node.label?.trim();
  if (!webView || !label) return null;
  if (isDocumentTitleWrapper(node, webView, label)) return { kind: 'suppress' };
  if (!isWebTextLeafWrapper(node, label, childrenByParent)) return null;
  return {
    kind: 'semantic',
    type: isHtmlHeadingLevel(node.value) ? 'Heading' : 'StaticText',
  };
}

function isWebTextLeafWrapper(
  node: RawSnapshotNode,
  label: string,
  childrenByParent: ReadonlyMap<number, RawSnapshotNode[]>,
): boolean {
  const children = childrenByParent.get(node.index);
  if (children?.length !== 1) return false;
  const text = children[0]!;
  return (
    normalizeType(text.type ?? '') === 'statictext' &&
    text.label?.trim() === label &&
    !childrenByParent.has(text.index)
  );
}

function isDocumentTitleWrapper(
  node: RawSnapshotNode,
  webView: RawSnapshotNode,
  label: string,
): boolean {
  return (
    node.parentIndex === webView.index &&
    webView.label?.trim() === label &&
    !isHtmlHeadingLevel(node.value)
  );
}

function isWebView(node: RawSnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  return type === 'webview' || type === 'element(58)';
}

function isHtmlHeadingLevel(value: string | undefined): boolean {
  return /^[1-6]$/.test(value?.trim() ?? '');
}
