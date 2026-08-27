import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { isSystemScrollIndicatorLabel } from '@agent-device/kernel/scroll-indicator';
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
    const rowLabel = row ? resolveIosRowLabel(nodes, position, row, context) : undefined;
    if (!row?.rect || !rowLabel) {
      continue;
    }
    collectIosRowPresentationForNode(nodes, position, row, rowLabel, context);
  }
}

function resolveIosRowLabel(
  nodes: RawSnapshotNode[],
  position: number,
  row: RawSnapshotNode,
  context: SnapshotTreeRuleContext,
): string | undefined {
  const rowLabel = row.label?.trim();
  if (
    normalizeType(row.type ?? '') !== 'cell' ||
    (rowLabel &&
      !isImplementationCellLabel(rowLabel, row.identifier) &&
      !isSystemScrollIndicatorLabel(rowLabel))
  ) {
    return rowLabel;
  }

  const titleNode = collectDescendants(nodes, position).find(isIosRowTitleCandidate);
  const title = titleNode?.label?.trim();
  if (!titleNode || !title) {
    return rowLabel;
  }
  mergeReplacement(context.replacements, row, { label: title });
  context.suppressNode(titleNode, [row]);
  return title;
}

function isImplementationCellLabel(label: string, identifier: string | undefined): boolean {
  return identifier?.trim() === label && /^[A-Z_$][A-Za-z0-9_$]*Cell$/.test(label);
}

function isIosRowTitleCandidate(node: RawSnapshotNode): boolean {
  const label = node.label?.trim();
  if (!label) {
    return false;
  }
  const type = normalizeType(node.type ?? '');
  return type === 'statictext' || type === 'text' || type === 'textview';
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
    suppressRepeatedRowDescendants(descendants, rowLabel, context, row);
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
  context.suppressNode(row, [switchControl]);
  suppressSwitchRowDescendants(descendants, row, rowLabel, switchControl, context);
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
      suppressRepeatedRowDescendants(descendants, rowLabel, context, row);
    }
    return;
  }

  if (!row.identifier && rowButton.identifier) {
    mergeReplacement(context.replacements, row, { identifier: rowButton.identifier });
  }

  context.suppressNode(rowButton, [row]);
  suppressRepeatedRowDescendants(
    descendants.filter((descendant) => descendant.index !== rowButton.index),
    rowLabel,
    context,
    row,
  );
}

function suppressSwitchRowDescendants(
  descendants: RawSnapshotNode[],
  row: RawSnapshotNode,
  rowLabel: string,
  switchControl: RawSnapshotNode,
  context: SnapshotTreeRuleContext,
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
      context.suppressNode(descendant, [switchControl]);
    }
  }
}

function suppressRepeatedRowDescendants(
  descendants: RawSnapshotNode[],
  rowLabel: string,
  context: SnapshotTreeRuleContext,
  row?: RawSnapshotNode,
): void {
  for (const descendant of descendants) {
    if (
      shouldSuppressRepeatedTextDescendant(descendant, rowLabel) ||
      (row && isEmptyRowButtonWrapper(descendant, row))
    ) {
      context.suppressNode(descendant, row ? [row] : []);
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
