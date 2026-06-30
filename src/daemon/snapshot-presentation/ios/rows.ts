import type { RawSnapshotNode } from '../../../kernel/snapshot.ts';
import { normalizeType } from '../../../snapshot/snapshot-processing.ts';
import {
  areRectsApproximatelyEqual,
  collectDescendants,
  isDisabledChevronButton,
  mergeReplacement,
  shouldSuppressRepeatedTextDescendant,
  type SnapshotTreeRuleContext,
} from '../tree.ts';

export function collectIosRowPresentation(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  for (let position = 0; position < nodes.length; position += 1) {
    const row = nodes[position];
    const rowLabel = row?.label?.trim();
    if (!row?.rect || !rowLabel) {
      continue;
    }
    collectIosRowPresentationForNode(nodes, position, row, rowLabel, context);
  }
}

function collectIosRowPresentationForNode(
  nodes: RawSnapshotNode[],
  position: number,
  row: RawSnapshotNode,
  rowLabel: string,
  context: SnapshotTreeRuleContext,
): void {
  const rowType = normalizeType(row.type ?? '');
  if (rowType === 'button') {
    const descendants = collectDescendants(nodes, position);
    suppressRepeatedRowDescendants(descendants, rowLabel, context.suppressedIndexes, row);
    return;
  }
  if (rowType !== 'cell') {
    return;
  }
  const descendants = collectDescendants(nodes, position);
  if (collectSwitchRowPresentation(descendants, row, rowLabel, context)) {
    return;
  }
  collectButtonRowPresentation(descendants, row, rowLabel, context);
}

function collectSwitchRowPresentation(
  descendants: RawSnapshotNode[],
  row: RawSnapshotNode,
  rowLabel: string,
  context: SnapshotTreeRuleContext,
): boolean {
  const switchControl = descendants.find((candidate) =>
    isIosRowSwitchCandidate(candidate, row, rowLabel),
  );
  if (!switchControl) {
    return false;
  }
  const rowButton = descendants.find((candidate) =>
    isIosRowButtonCandidate(candidate, row, rowLabel),
  );
  const promotedIdentifier = switchControl.identifier
    ? undefined
    : (rowButton?.identifier ?? row.identifier);
  if (promotedIdentifier) {
    mergeReplacement(context.replacements, switchControl, { identifier: promotedIdentifier });
  }
  context.suppressedIndexes.add(row.index);
  suppressSwitchRowDescendants(
    descendants,
    row,
    rowLabel,
    switchControl,
    context.suppressedIndexes,
  );
  return true;
}

function collectButtonRowPresentation(
  descendants: RawSnapshotNode[],
  row: RawSnapshotNode,
  rowLabel: string,
  context: SnapshotTreeRuleContext,
): void {
  const rowButton = descendants.find((candidate) =>
    isIosRowButtonCandidate(candidate, row, rowLabel),
  );
  if (!rowButton) {
    if (descendants.some(isDisabledChevronButton)) {
      suppressRepeatedRowDescendants(descendants, rowLabel, context.suppressedIndexes, row);
    }
    return;
  }

  if (!row.identifier && rowButton.identifier) {
    mergeReplacement(context.replacements, row, { identifier: rowButton.identifier });
  }

  context.suppressedIndexes.add(rowButton.index);
  suppressRepeatedRowDescendants(
    descendants.filter((descendant) => descendant.index !== rowButton.index),
    rowLabel,
    context.suppressedIndexes,
    row,
  );
}

function suppressSwitchRowDescendants(
  descendants: RawSnapshotNode[],
  row: RawSnapshotNode,
  rowLabel: string,
  switchControl: RawSnapshotNode,
  suppressedIndexes: Set<number>,
): void {
  for (const descendant of descendants) {
    if (descendant.index === switchControl.index) {
      continue;
    }
    if (
      isIosRowButtonCandidate(descendant, row, rowLabel) ||
      isEmptyRowButtonWrapper(descendant, row) ||
      isIosSwitchValueDescendant(descendant, switchControl) ||
      shouldSuppressRepeatedTextDescendant(descendant, rowLabel)
    ) {
      suppressedIndexes.add(descendant.index);
    }
  }
}

function suppressRepeatedRowDescendants(
  descendants: RawSnapshotNode[],
  rowLabel: string,
  suppressedIndexes: Set<number>,
  row?: RawSnapshotNode,
): void {
  for (const descendant of descendants) {
    if (
      shouldSuppressRepeatedTextDescendant(descendant, rowLabel) ||
      (row && isEmptyRowButtonWrapper(descendant, row))
    ) {
      suppressedIndexes.add(descendant.index);
    }
  }
}

function isIosRowButtonCandidate(
  candidate: RawSnapshotNode,
  row: RawSnapshotNode,
  rowLabel: string,
): boolean {
  if (normalizeType(candidate.type ?? '') !== 'button') {
    return false;
  }
  const rowIdentifier = row.identifier?.trim();
  const candidateIdentifier = candidate.identifier?.trim();
  if (rowIdentifier && candidateIdentifier && rowIdentifier === candidateIdentifier) {
    return true;
  }
  const candidateLabel = candidate.label?.trim();
  return candidateLabel === rowLabel && areRectsApproximatelyEqual(candidate.rect, row.rect);
}

function isEmptyRowButtonWrapper(node: RawSnapshotNode, row: RawSnapshotNode): boolean {
  return (
    normalizeType(node.type ?? '') === 'button' &&
    !node.label?.trim() &&
    !node.value?.trim() &&
    areRectsApproximatelyEqual(node.rect, row.rect)
  );
}

function isIosRowSwitchCandidate(
  candidate: RawSnapshotNode,
  row: RawSnapshotNode,
  rowLabel: string,
): boolean {
  if (normalizeType(candidate.type ?? '') !== 'switch') {
    return false;
  }
  const rowIdentifier = row.identifier?.trim();
  const candidateIdentifier = candidate.identifier?.trim();
  if (rowIdentifier && candidateIdentifier && rowIdentifier === candidateIdentifier) {
    return true;
  }
  return candidate.label?.trim() === rowLabel;
}

function isIosSwitchValueDescendant(
  node: RawSnapshotNode,
  switchControl: RawSnapshotNode,
): boolean {
  if (normalizeType(node.type ?? '') !== 'switch') {
    return false;
  }
  if (node.index === switchControl.index) {
    return false;
  }
  const label = node.label?.trim();
  return label === switchControl.value?.trim() || label === '0' || label === '1';
}
