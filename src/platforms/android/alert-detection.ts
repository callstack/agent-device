import { centerOfRect, type RawSnapshotNode } from '../../kernel/snapshot.ts';
import type { AlertInfo, AlertSource } from '../../alert-contract.ts';

type AndroidAlertButtonRole = 'accept' | 'dismiss' | 'neutral';

export type AndroidAlertButton = {
  label: string;
  x: number;
  y: number;
  role: AndroidAlertButtonRole;
};

type AndroidAlertSource = Extract<AlertSource, 'permission' | 'native-dialog' | 'system-dialog'>;

export type AndroidAlertInfo = AlertInfo & {
  buttons: string[];
  platform: 'android';
  source: AndroidAlertSource;
  packageName?: string;
};

export type AndroidAlertCandidate = {
  alert: AndroidAlertInfo;
  buttons: AndroidAlertButton[];
};

const ANDROID_PERMISSION_PACKAGES = new Set([
  'com.android.permissioncontroller',
  'com.google.android.permissioncontroller',
  'com.google.android.packageinstaller',
  'com.android.packageinstaller',
]);
const ANDROID_SYSTEM_DIALOG_PACKAGES = new Set(['android', 'com.android.systemui']);
const ANDROID_ALERT_ID_PATTERN =
  /^android:id\/(?:alertTitle|message|button[123]|parentPanel|buttonPanel|contentPanel)$/i;
const ANDROID_ALERT_BUTTON_ID_PATTERN = /^android:id\/button[123]$/i;
const ANDROID_PERMISSION_ID_PATTERN = /(?:^|:)id\/permission_/i;
const ANDROID_BLOCKING_DIALOG_PATTERN =
  /\b(?:is(?:n't| not) responding|keeps stopping|has stopped|close app|app info)\b/i;
const ACCEPT_LABEL_PATTERN =
  /^(?:ok|allow|allow all|while using the app|only this time|yes|continue|save|confirm|turn on|open settings)$/i;
const DISMISS_LABEL_PATTERN =
  /^(?:cancel|deny|don.t allow|don’t allow|not now|no|dismiss|close|close app|later|skip)$/i;

export function classifyAndroidAlertIdentifier(
  identifier: string | null,
): 'button' | 'content' | undefined {
  if (identifier === null) return undefined;
  if (ANDROID_ALERT_BUTTON_ID_PATTERN.test(identifier)) return 'button';
  if (ANDROID_ALERT_ID_PATTERN.test(identifier)) return 'content';
  return undefined;
}

export function findAndroidAlertCandidate(nodes: RawSnapshotNode[]): AndroidAlertCandidate | null {
  const candidate = findAndroidAlertNodes(nodes);
  const candidateNodes = candidate.nodes;
  if (candidateNodes.length === 0) return null;

  const buttons = findAlertButtons(candidateNodes);
  const textNodes = candidateNodes.filter((node) => readNodeText(node) && !isButtonLike(node));
  const title = chooseAlertTitle(textNodes);
  const message = chooseAlertMessage(textNodes, title);
  const packageName = choosePackageName(candidateNodes);
  return {
    alert: {
      ...(title ? { title } : {}),
      ...(message ? { message } : {}),
      buttons: buttons.map((button) => button.label),
      platform: 'android',
      source: candidate.source,
      ...(packageName ? { packageName } : {}),
    },
    buttons,
  };
}

export function chooseAndroidAlertButton(
  buttons: AndroidAlertButton[],
  action: 'accept' | 'dismiss',
): AndroidAlertButton | null {
  const role = action === 'accept' ? 'accept' : 'dismiss';
  const exact = buttons.find((button) => button.role === role);
  if (exact) return exact;
  if (action === 'dismiss') {
    return buttons.find((button) => button.role === 'neutral') ?? null;
  }
  // Single-button Android dialogs commonly expose the only affirmative path as OK.
  return buttons.length === 1 ? (buttons[0] ?? null) : null;
}

function findAndroidAlertNodes(nodes: RawSnapshotNode[]): {
  nodes: RawSnapshotNode[];
  source: AndroidAlertInfo['source'];
} {
  const permissionNodes = nodes.filter((node) => isAndroidPermissionNode(node));
  if (permissionNodes.length) return { nodes: permissionNodes, source: 'permission' };

  const systemDialogNodes = findSystemDialogNodes(nodes);
  if (systemDialogNodes.length) return { nodes: systemDialogNodes, source: 'system-dialog' };

  return { nodes: findNativeDialogNodes(nodes), source: 'native-dialog' };
}

function findNativeDialogNodes(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  const dialogNodes = nodes.filter((node) => isAndroidDialogType(node.type ?? ''));
  const alertIdNodes = nodes.filter((node) => ANDROID_ALERT_ID_PATTERN.test(node.identifier ?? ''));
  const signalNodes = dialogNodes.length
    ? [...dialogNodes, ...alertIdNodes]
    : correlatedAndroidAlertIdNodes(alertIdNodes);
  if (signalNodes.length === 0) return [];
  const rootIndex = findCommonAncestorIndex(nodes, signalNodes);
  if (rootIndex === undefined) return signalNodes;
  return collectDescendants(nodes, rootIndex);
}

function isAndroidDialogType(type: string): boolean {
  return /(?:^|[.$])[^.]*Dialog$/i.test(type);
}

function correlatedAndroidAlertIdNodes(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  const hasButton = nodes.some((node) =>
    ANDROID_ALERT_BUTTON_ID_PATTERN.test(node.identifier ?? ''),
  );
  const hasContent = nodes.some(
    (node) => !ANDROID_ALERT_BUTTON_ID_PATTERN.test(node.identifier ?? ''),
  );
  return hasButton && hasContent ? nodes : [];
}

function findSystemDialogNodes(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  const signalNodes = nodes.filter((node) => isAndroidSystemDialogNode(node));
  if (signalNodes.length === 0) return [];
  const rootIndex = findCommonAncestorIndex(nodes, signalNodes);
  if (rootIndex === undefined) return signalNodes;
  return collectDescendants(nodes, rootIndex).filter(
    (node) => node.bundleId && ANDROID_SYSTEM_DIALOG_PACKAGES.has(node.bundleId),
  );
}

function findAlertButtons(nodes: RawSnapshotNode[]): AndroidAlertButton[] {
  const seen = new Set<string>();
  const buttons: AndroidAlertButton[] = [];
  for (const node of nodes) {
    const label = readNodeText(node);
    if (!label || !node.rect || !isButtonLike(node)) continue;
    const normalized = label.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    const point = centerOfRect(node.rect);
    buttons.push({
      label,
      x: point.x,
      y: point.y,
      role: classifyAndroidAlertButton(node, label),
    });
  }
  return buttons;
}

function classifyAndroidAlertButton(node: RawSnapshotNode, label: string): AndroidAlertButtonRole {
  const identifier = node.identifier ?? '';
  const roleFromId = classifyAndroidAlertButtonById(identifier);
  if (roleFromId) return roleFromId;
  if (ACCEPT_LABEL_PATTERN.test(label.trim())) return 'accept';
  if (DISMISS_LABEL_PATTERN.test(label.trim())) return 'dismiss';
  return 'neutral';
}

function classifyAndroidAlertButtonById(identifier: string): AndroidAlertButtonRole | null {
  if (/(?:^|:)id\/button1$/i.test(identifier)) return 'accept';
  if (/(?:^|:)id\/button2$/i.test(identifier)) return 'dismiss';
  if (/(?:^|:)id\/button3$/i.test(identifier)) return 'neutral';
  if (/(?:^|:)id\/permission_allow/i.test(identifier)) return 'accept';
  if (/(?:^|:)id\/permission_deny/i.test(identifier)) return 'dismiss';
  return null;
}

function chooseAlertTitle(nodes: RawSnapshotNode[]): string | undefined {
  const explicit = nodes.find((node) =>
    /(?:^|:)id\/(?:alertTitle|permission_message)$/i.test(node.identifier ?? ''),
  );
  return readNodeText(explicit) || readNodeText(nodes[0]);
}

function chooseAlertMessage(
  nodes: RawSnapshotNode[],
  title: string | undefined,
): string | undefined {
  const parts = nodes.map((node) => readNodeText(node)).filter((text) => text && text !== title);
  return parts.length ? [...new Set(parts)].join('\n') : undefined;
}

function findCommonAncestorIndex(
  nodes: RawSnapshotNode[],
  signalNodes: RawSnapshotNode[],
): number | undefined {
  const first = signalNodes[0];
  if (!first) return undefined;
  const common = ancestorIndexes(nodes, first.index);
  for (const signal of signalNodes.slice(1)) {
    const ancestors = new Set(ancestorIndexes(nodes, signal.index));
    for (let index = common.length - 1; index >= 0; index -= 1) {
      if (!ancestors.has(common[index]!)) {
        common.splice(index, 1);
      }
    }
  }
  return common[common.length - 1];
}

function ancestorIndexes(nodes: RawSnapshotNode[], index: number): number[] {
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const indexes: number[] = [];
  let current = byIndex.get(index);
  while (current) {
    indexes.push(current.index);
    current = current.parentIndex === undefined ? undefined : byIndex.get(current.parentIndex);
  }
  return indexes.reverse();
}

function collectDescendants(nodes: RawSnapshotNode[], rootIndex: number): RawSnapshotNode[] {
  const childrenByParent = new Map<number, RawSnapshotNode[]>();
  for (const node of nodes) {
    if (node.parentIndex === undefined) continue;
    const siblings = childrenByParent.get(node.parentIndex) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentIndex, siblings);
  }

  const descendants = new Set<number>([rootIndex]);
  const pending = [rootIndex];
  for (const index of pending) {
    for (const child of childrenByParent.get(index) ?? []) {
      if (descendants.has(child.index)) continue;
      descendants.add(child.index);
      pending.push(child.index);
    }
  }
  return nodes.filter((node) => descendants.has(node.index));
}

function isAndroidPermissionNode(node: RawSnapshotNode): boolean {
  const packageName = node.bundleId ?? '';
  return (
    ANDROID_PERMISSION_PACKAGES.has(packageName) ||
    ANDROID_PERMISSION_ID_PATTERN.test(node.identifier ?? '')
  );
}

function isAndroidSystemDialogNode(node: RawSnapshotNode): boolean {
  const packageName = node.bundleId ?? '';
  return (
    ANDROID_SYSTEM_DIALOG_PACKAGES.has(packageName) &&
    ANDROID_BLOCKING_DIALOG_PATTERN.test(readNodeText(node))
  );
}

function isButtonLike(node: RawSnapshotNode): boolean {
  const type = node.type ?? '';
  const identifier = node.identifier ?? '';
  return Boolean(
    node.hittable ||
    /\bbutton\b/i.test(type) ||
    ANDROID_ALERT_BUTTON_ID_PATTERN.test(identifier) ||
    /(?:^|:)id\/permission_(?:allow|deny)/i.test(identifier),
  );
}

function readNodeText(node: RawSnapshotNode | undefined): string {
  if (!node) return '';
  const parts = [node.label, node.value].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  return parts[0]?.trim() ?? '';
}

function choosePackageName(nodes: RawSnapshotNode[]): string | undefined {
  return nodes.find((node) => node.bundleId)?.bundleId;
}
