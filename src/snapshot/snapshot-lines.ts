import { isSystemScrollIndicatorLabel } from '../utils/scroll-indicator.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { buildTextPreview, describeTextSurface, trimText } from '../utils/text-surface.ts';

type SnapshotDisplayLine = {
  node: SnapshotNode;
  depth: number;
  type: string;
  text: string;
};

type SnapshotLineFormatOptions = {
  summarizeTextSurfaces?: boolean;
};

const ROLE_LABELS: Record<string, string> = {
  application: 'application',
  navigationbar: 'navigation-bar',
  tabbar: 'tab-bar',
  button: 'button',
  imagebutton: 'button',
  link: 'link',
  cell: 'cell',
  statictext: 'text',
  checkedtextview: 'text',
  textbox: 'text-field',
  textfield: 'text-field',
  edittext: 'text-field',
  textarea: 'text-view',
  switch: 'switch',
  slider: 'slider',
  image: 'image',
  imageview: 'image',
  webview: 'webview',
  framelayout: 'group',
  linearlayout: 'group',
  relativelayout: 'group',
  constraintlayout: 'group',
  viewgroup: 'group',
  view: 'group',
  listview: 'list',
  recyclerview: 'list',
  collectionview: 'collection',
  searchfield: 'search',
  segmentedcontrol: 'segmented-control',
  group: 'group',
  window: 'window',
  checkbox: 'checkbox',
  radio: 'radio',
  menuitem: 'menu-item',
  toolbar: 'toolbar',
  scrollarea: 'scroll-area',
  scrollview: 'scroll-area',
  nestedscrollview: 'scroll-area',
  table: 'table',
};

export function buildSnapshotDisplayLines(
  nodes: SnapshotNode[],
  options: SnapshotLineFormatOptions = {},
): SnapshotDisplayLine[] {
  const visibleDepths: number[] = [];
  const lines: SnapshotDisplayLine[] = [];
  for (const node of nodes) {
    const depth = node.depth ?? 0;
    const label = node.label?.trim() || node.value?.trim() || node.identifier?.trim() || '';
    const type = formatRole(node.type ?? 'Element');
    const hasInheritedLabel = node.inheritsLabel === true || node.inheritsIdentifier === true;
    if (type === 'group' && !label && !hasInheritedLabel) {
      continue;
    }
    while (visibleDepths.length > 0 && depth <= visibleDepths[visibleDepths.length - 1]!) {
      visibleDepths.pop();
    }
    const adjustedDepth = visibleDepths.length;
    visibleDepths.push(depth);
    lines.push({
      node,
      depth: adjustedDepth,
      type,
      text: formatSnapshotLine(node, adjustedDepth, false, type, options),
    });
  }
  return lines;
}

export function formatSnapshotLine(
  node: SnapshotNode,
  depth: number,
  hiddenGroup: boolean,
  normalizedType?: string,
  options: SnapshotLineFormatOptions = {},
): string {
  const type = normalizedType ?? formatRole(node.type ?? 'Element');
  const textSurface = describeTextSurface(node, type);
  const label = resolveDisplayLabel(node, type, options, textSurface);
  const indent = '  '.repeat(depth);
  const ref = node.ref ? `@${node.ref}` : '';
  const metadata = buildLineMetadata(node, type, options, textSurface);
  if (!label && (node.inheritsLabel === true || node.inheritsIdentifier === true)) {
    metadata.push('same label as parent');
  }
  const metadataText = metadata.map((entry) => ` [${entry}]`).join('');
  const textPart = label ? ` "${label}"` : '';
  if (hiddenGroup) {
    return `${indent}${ref} [${type}]${metadataText}`.trimEnd();
  }
  return `${indent}${ref} [${type}]${textPart}${metadataText}`.trimEnd();
}

export function displayLabel(node: SnapshotNode, type: string): string {
  const label = node.label?.trim();
  if (label && shouldSuppressScrollContainerLabel(type, label)) {
    return '';
  }
  const value = node.value?.trim();
  if (isEditableRole(type)) {
    if (value) return value;
    if (label) return label;
  } else if (label) {
    return label;
  }
  if (value) return value;
  const identifier = node.identifier?.trim();
  if (!identifier) return '';
  if (
    isGenericResourceId(identifier) &&
    (type === 'group' || type === 'image' || type === 'list' || type === 'collection')
  ) {
    return '';
  }
  return identifier;
}

export function formatRole(type: string): string {
  const raw = type;
  let normalized = type.replace(/XCUIElementType/gi, '').toLowerCase();
  const isAndroidClass =
    raw.includes('.') &&
    (raw.startsWith('android.') || raw.startsWith('androidx.') || raw.startsWith('com.'));
  if (normalized.includes('.')) {
    normalized = normalized
      .replace(/^android\.widget\./, '')
      .replace(/^android\.view\./, '')
      .replace(/^android\.webkit\./, '')
      .replace(/^androidx\./, '')
      .replace(/^com\.google\.android\./, '')
      .replace(/^com\.android\./, '');
    if (isAndroidClass && normalized.includes('.')) {
      normalized = normalized.slice(normalized.lastIndexOf('.') + 1);
    }
  }
  if (normalized === 'textview') {
    return isAndroidClass ? 'text' : 'text-view';
  }
  return lookupRoleLabel(normalized) || normalized || 'element';
}

function lookupRoleLabel(normalized: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, normalized)
    ? ROLE_LABELS[normalized]
    : undefined;
}

function isEditableRole(type: string): boolean {
  return type === 'text-field' || type === 'text-view' || type === 'search';
}

function shouldSuppressScrollContainerLabel(type: string, label: string): boolean {
  if (type !== 'scroll-area' && type !== 'list' && type !== 'collection' && type !== 'table') {
    return false;
  }
  return isSystemScrollIndicatorLabel(label);
}

function isGenericResourceId(value: string): boolean {
  return /^[\w.]+:id\/[\w.-]+$/i.test(value);
}

function resolveDisplayLabel(
  node: SnapshotNode,
  type: string,
  options: SnapshotLineFormatOptions,
  textSurface: { text: string; isLargeSurface: boolean; shouldSummarize: boolean },
): string {
  if (!options.summarizeTextSurfaces) {
    return displayLabel(node, type);
  }
  if (!textSurface.shouldSummarize) {
    return displayLabel(node, type);
  }
  const semanticLabel = semanticSurfaceLabel(node, type, textSurface.text);
  return semanticLabel || displayLabel(node, type);
}

function buildLineMetadata(
  node: SnapshotNode,
  type: string,
  options: SnapshotLineFormatOptions,
  textSurface: { text: string; isLargeSurface: boolean; shouldSummarize: boolean },
): string[] {
  const metadata: string[] = [];
  if (node.enabled === false) metadata.push('disabled');
  metadata.push(...(node.presentationHints ?? []));
  if (!options.summarizeTextSurfaces) {
    return uniqueMetadata(metadata);
  }
  if (node.selected === true) metadata.push('selected');
  if (node.focused === true) metadata.push('focused');
  if (isEditableRole(type)) metadata.push('editable');
  if (looksScrollable(node, type)) metadata.push('scrollable');
  if (!textSurface.shouldSummarize) {
    return uniqueMetadata(metadata);
  }
  metadata.push(`preview:"${escapePreviewText(buildTextPreview(textSurface.text))}"`);
  metadata.push('truncated');
  return uniqueMetadata(metadata);
}

function semanticSurfaceLabel(node: SnapshotNode, type: string, text: string): string {
  const label = trimText(node.label);
  if (label && label !== text) {
    return label;
  }
  const identifier = trimText(node.identifier);
  if (identifier && !isGenericResourceId(identifier) && identifier !== text) {
    return identifier;
  }
  switch (type) {
    case 'text':
    case 'text-view':
      return 'Text view';
    case 'text-field':
      return 'Text field';
    case 'search':
      return 'Search field';
    default:
      return '';
  }
}

function looksScrollable(node: SnapshotNode, type: string): boolean {
  if (type === 'scroll-area') {
    return true;
  }
  const rawType = (node.type ?? '').toLowerCase();
  const rawRole = `${node.role ?? ''} ${node.subrole ?? ''}`.toLowerCase();
  return rawType.includes('scroll') || rawRole.includes('scroll');
}

function escapePreviewText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function uniqueMetadata(values: string[]): string[] {
  return [...new Set(values)];
}
