import type { SnapshotOptions } from '@agent-device/kernel/snapshot';
import { isScrollableType } from '@agent-device/contracts/snapshot';
import { isAgentTarget, isGenericAndroidId, type AndroidNode } from './ui-hierarchy-node.ts';

type AndroidNodeInclusionInfo = {
  type: string;
  hasMeaningfulText: boolean;
  hasMeaningfulId: boolean;
  isStructural: boolean;
  isVisual: boolean;
};

export function shouldIncludeAndroidNode(
  node: AndroidNode,
  options: SnapshotOptions,
  ancestorHittable: boolean,
  descendantHittable: boolean,
  ancestorCollection: boolean,
): boolean {
  if (node.visibleToUser === false) return false;
  const info = getAndroidNodeInclusionInfo(node);
  if (options.interactiveOnly) {
    return shouldIncludeInteractiveAndroidNode(
      node,
      info,
      ancestorHittable,
      descendantHittable,
      ancestorCollection,
    );
  }
  if (info.isStructural || info.isVisual) {
    return shouldIncludeStructuralAndroidNode(node, info, descendantHittable);
  }
  return true;
}

function getAndroidNodeInclusionInfo(node: AndroidNode): AndroidNodeInclusionInfo {
  const type = normalizeAndroidType(node.type);
  const hasText = Boolean(node.label && node.label.trim().length > 0);
  const hasId = Boolean(node.identifier && node.identifier.trim().length > 0);
  return {
    type,
    hasMeaningfulText: hasText && !isGenericAndroidId(node.label ?? ''),
    hasMeaningfulId: hasId && !isGenericAndroidId(node.identifier ?? ''),
    isStructural: isStructuralAndroidType(type),
    isVisual: type === 'imageview' || type === 'imagebutton',
  };
}

function shouldIncludeInteractiveAndroidNode(
  node: AndroidNode,
  info: AndroidNodeInclusionInfo,
  ancestorHittable: boolean,
  descendantHittable: boolean,
  ancestorCollection: boolean,
): boolean {
  if (hasNonPositiveRect(node)) return false;
  if (isAgentTarget(node)) return true;
  if (isScrollableType(info.type) && descendantHittable) return true;
  return shouldIncludeInteractiveProxyNode(
    info,
    ancestorHittable,
    descendantHittable,
    ancestorCollection,
  );
}

function shouldIncludeInteractiveProxyNode(
  info: AndroidNodeInclusionInfo,
  ancestorHittable: boolean,
  descendantHittable: boolean,
  ancestorCollection: boolean,
): boolean {
  if (!info.hasMeaningfulText && !info.hasMeaningfulId) return false;
  if (info.isVisual) return false;
  // Compose commonly places the app-owned content description on a passive
  // `android.view.View` inside the clickable container. Keep that semantic
  // proxy so presentation can associate the label with the action.
  if (info.isStructural && !ancestorCollection && !ancestorHittable) return false;
  return ancestorHittable || descendantHittable || ancestorCollection;
}

function hasNonPositiveRect(node: AndroidNode): boolean {
  return Boolean(node.rect && (node.rect.width <= 0 || node.rect.height <= 0));
}

function shouldIncludeStructuralAndroidNode(
  node: AndroidNode,
  info: AndroidNodeInclusionInfo,
  descendantHittable: boolean,
): boolean {
  if (isAgentTarget(node)) return true;
  if (info.hasMeaningfulText) return true;
  if (info.hasMeaningfulId) return true;
  return descendantHittable;
}

export function isCollectionContainerType(type: string | null): boolean {
  if (!type) return false;
  const normalized = normalizeAndroidType(type);
  return (
    normalized.includes('recyclerview') ||
    normalized.includes('listview') ||
    normalized.includes('gridview')
  );
}

function normalizeAndroidType(type: string | null): string {
  if (!type) return '';
  return type.toLowerCase();
}

function isStructuralAndroidType(type: string): boolean {
  const short = type.split('.').pop() ?? type;
  return short.includes('layout') || short === 'viewgroup' || short === 'view';
}
