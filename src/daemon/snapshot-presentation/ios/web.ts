import type { RawSnapshotNode } from '../../../kernel/snapshot.ts';
import { normalizeType } from '../../../snapshot/snapshot-processing.ts';
import { findNearestAncestor, mergeReplacement, type SnapshotTreeRuleContext } from '../tree.ts';

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
  const repeatedStaticTextByParent = collectRepeatedStaticTextByParent(nodes);

  for (const node of nodes) {
    if (normalizeType(node.type ?? '') === 'element(58)') {
      mergeReplacement(context.replacements, node, { type: 'WebView' });
      continue;
    }
    const presentation = classifyIosWebTextWrapper(
      node,
      context.sourceNodesByIndex,
      repeatedStaticTextByParent,
    );
    if (presentation?.kind === 'suppress') {
      context.suppressedIndexes.add(node.index);
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
  repeatedStaticTextByParent: Map<number, Set<string>>,
): IosWebTextWrapperPresentation | null {
  if (normalizeType(node.type ?? '') !== 'other') return null;
  const webView = findNearestAncestor(node, byIndex, isWebView);
  const label = node.label?.trim();
  if (!webView || !label) return null;
  if (isDocumentTitleWrapper(node, webView, label)) return { kind: 'suppress' };
  if (!repeatedStaticTextByParent.get(node.index)?.has(label)) return null;
  return {
    kind: 'semantic',
    type: isHtmlHeadingLevel(node.value) ? 'Heading' : 'StaticText',
  };
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

function collectRepeatedStaticTextByParent(nodes: RawSnapshotNode[]): Map<number, Set<string>> {
  const labelsByParent = new Map<number, Set<string>>();
  for (const node of nodes) {
    if (typeof node.parentIndex !== 'number' || normalizeType(node.type ?? '') !== 'statictext') {
      continue;
    }
    const label = node.label?.trim();
    if (!label) continue;
    const labels = labelsByParent.get(node.parentIndex) ?? new Set<string>();
    labels.add(label);
    labelsByParent.set(node.parentIndex, labels);
  }
  return labelsByParent;
}

function isWebView(node: RawSnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  return type === 'webview' || type === 'element(58)';
}

function isHtmlHeadingLevel(value: string | undefined): boolean {
  return /^[1-6]$/.test(value?.trim() ?? '');
}
