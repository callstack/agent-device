import { centerOfRect, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  type AlertButtonRole,
  classifyAlertButtonRole,
  type AlertInfo,
  type AlertSource,
  selectRankedAlertButtonByRole,
} from '@agent-device/contracts/alert-contract';
import { isSnapshotNodeInteractionBlocked } from '@agent-device/capture-kit/snapshot-occlusion';

export type AndroidAlertButton = {
  label: string;
  x: number;
  y: number;
  role: AlertButtonRole;
  /** The node's resource id — the backend-owned fact that can rank a grant's role. */
  identifier: string;
  /**
   * The id states a permission grant (`permission_allow*` / `permission_deny*`) that no slot of
   * PERMISSION_GRANT_ID_SLOTS knows. Only a declared slot names such a button's role: an
   * undeclared grant carries no role for any source, and no label can give it one. Its presence
   * makes the whole sheet unactionable.
   */
  hasUndeclaredGrant: boolean;
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

/** Packages that host runtime-permission and install prompts — a legitimate `alert` source, never an app escape. */
export function isAndroidPermissionPackage(packageName: string): boolean {
  return ANDROID_PERMISSION_PACKAGES.has(packageName);
}
const ANDROID_SYSTEM_DIALOG_PACKAGES = new Set(['android', 'com.android.systemui']);
const ANDROID_ALERT_ID_PATTERN =
  /^android:id\/(?:alertTitle|message|button[123]|parentPanel|buttonPanel|contentPanel)$/i;
const ANDROID_ALERT_BUTTON_ID_PATTERN = /^android:id\/button[123]$/i;
const ANDROID_PERMISSION_ID_PATTERN = /(?:^|:)id\/permission_/i;
const ANDROID_BLOCKING_DIALOG_PATTERN =
  /\b(?:is(?:n't| not) responding|keeps stopping|has stopped|close app|app info)\b/i;

export function classifyAndroidAlertIdentifier(
  identifier: string | null,
): 'button' | 'content' | undefined {
  if (identifier === null) return undefined;
  if (ANDROID_ALERT_BUTTON_ID_PATTERN.test(identifier)) return 'button';
  if (ANDROID_ALERT_ID_PATTERN.test(identifier)) return 'content';
  return undefined;
}

export function findAndroidAlertCandidate(nodes: RawSnapshotNode[]): AndroidAlertCandidate | null {
  const candidate = findAndroidAlertNodes(nodes.filter(isReachableAlertNode));
  const candidateNodes = candidate.nodes;
  if (candidateNodes.length === 0) return null;

  const buttons = findAlertButtons(candidateNodes);
  const textNodes = candidateNodes.filter((node) => readNodeText(node) && !isButtonLike(node));
  const title = chooseAlertTitle(textNodes);
  const message = chooseAlertMessage(textNodes, title);
  if (!title && !message && buttons.length === 0) return null;
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

function isReachableAlertNode(node: RawSnapshotNode): boolean {
  return !isSnapshotNodeInteractionBlocked(node);
}

/**
 * Android's acting policy on the shared choice boundary: the action's role-named button chosen
 * by declared preference — the permissioncontroller grant ids first (their role and rank come
 * from one declaration: full-access and foreground grants over picker-limited and one-time
 * ones, whatever language their labels are in), the shared label vocabulary where no grant id
 * exists; else, for dismiss, the first neutral button (Android dialogs commonly name the
 * leaving path only neutrally); else, for accept, a single-button dialog's only affirmative
 * path. Two choices that tie on one rank (the same label or the same grant id at two points), a
 * candidate no rank source reaches, or a grant id no slot declares refuse at the shared
 * boundary rather than resolving by tree order — the driver turns that refusal into a Back key
 * for dismiss, or a typed refusal.
 */
export function chooseAndroidAlertButton(
  buttons: AndroidAlertButton[],
  action: 'accept' | 'dismiss',
): AndroidAlertButton | null {
  // A grant id the declaration does not know makes the whole sheet unactionable for either
  // action. Dropping it would hand a remaining declared button the sole-candidate press;
  // keeping it only its own role would leave the other action's fallbacks — the neutral find,
  // the single-button press — aiming at a sheet whose grants nothing here ranks.
  if (buttons.some((button) => button.hasUndeclaredGrant)) return null;
  const exact = selectRankedAlertButtonByRole(buttons, action, rankAndroidAlertButtonById);
  if (exact) return exact;
  if (action === 'dismiss') {
    return buttons.find((button) => button.role === 'neutral') ?? null;
  }
  // Single-button Android dialogs commonly expose the only affirmative path as OK.
  return buttons.length === 1 ? (buttons[0] ?? null) : null;
}

/**
 * The AOSP permissioncontroller grant ids with the role and the rank each one states — the
 * single declaration the id classifier and the backend rank both read, so an accepted
 * permissioncontroller id can never carry a role without a rank. One slot per rank: earlier
 * slots win, and two ids inside one slot tie (the shared boundary refuses between them rather
 * than ordering ids Android never separated). The accept scale prefers a lasting grant: full
 * access ("Allow all": Android 13+ files, Android 14+ partial media) over foreground-only over
 * plain/always over a picker-limited grant ("Select photos and videos") over a one-time grant.
 * The dismiss scale then prefers the reversible decline: the plain deny over its don't-ask-again
 * variants. A controller id this table does not know (a vendor fork's own grant, or a future
 * AOSP grant) declares no role and no rank at all, and chooseAndroidAlertButton refuses the
 * whole sheet beside it — it is never silently dropped, never labelled into a role, and never
 * ordered by tree position.
 */
const PERMISSION_GRANT_ID_SLOTS: ReadonlyArray<{
  role: AlertButtonRole;
  ids: readonly RegExp[];
}> = [
  { role: 'accept', ids: [/(?:^|:)id\/permission_allow_all(?:_button)?$/i] },
  { role: 'accept', ids: [/(?:^|:)id\/permission_allow_foreground_only(?:_button)?$/i] },
  {
    role: 'accept',
    ids: [/(?:^|:)id\/permission_allow(?:_all_time|_always)?(?:_button)?$/i],
  },
  { role: 'accept', ids: [/(?:^|:)id\/permission_allow_selected(?:_button)?$/i] },
  { role: 'accept', ids: [/(?:^|:)id\/permission_allow_one_time(?:_button)?$/i] },
  { role: 'dismiss', ids: [/(?:^|:)id\/permission_deny(?:_button)?$/i] },
  {
    role: 'dismiss',
    ids: [/(?:^|:)id\/permission_deny(?:_and)?_dont_ask_again(?:_button)?$/i],
  },
];

/** The declared scale position of a known permissioncontroller grant id, or null. */
function permissionGrantIdSlot(identifier: string): number {
  return PERMISSION_GRANT_ID_SLOTS.findIndex((slot) =>
    slot.ids.some((pattern) => pattern.test(identifier)),
  );
}

/**
 * The backend-owned rank of a button named by a known grant id — the label-independent
 * preference the resource id states, on the same scale the id's role comes from. Any other id
 * ranks nothing here.
 */
function rankAndroidAlertButtonById(button: AndroidAlertButton): number | null {
  const slot = permissionGrantIdSlot(button.identifier);
  return slot === -1 ? null : slot;
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
  const lastSeparator = Math.max(type.lastIndexOf('.'), type.lastIndexOf('$'));
  return type
    .slice(lastSeparator + 1)
    .toLowerCase()
    .endsWith('dialog');
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
  const seenPhysicalButtons = new Set<string>();
  const buttons: AndroidAlertButton[] = [];
  for (const node of nodes) {
    const label = readNodeText(node);
    if (!label || !node.rect || !isButtonLike(node)) continue;
    const normalized = label.trim().toLowerCase();
    if (!normalized) continue;
    const point = centerOfRect(node.rect);
    // Two nodes over one center are the one physical button (uiautomator commonly nests it);
    // the same label at two centers is two buttons, and the shared choice boundary refuses —
    // collapsing them here would hand the first one back as if the capture had named it.
    const physicalButton = `${normalized}|${point.x}|${point.y}`;
    if (seenPhysicalButtons.has(physicalButton)) continue;
    seenPhysicalButtons.add(physicalButton);
    buttons.push({
      label,
      x: point.x,
      y: point.y,
      ...classifyAndroidAlertButton(node, label),
      identifier: node.identifier ?? '',
    });
  }
  return buttons;
}

function classifyAndroidAlertButton(
  node: RawSnapshotNode,
  label: string,
): Pick<AndroidAlertButton, 'role' | 'hasUndeclaredGrant'> {
  const identifier = node.identifier ?? '';
  const roleFromId = classifyAndroidAlertButtonById(identifier);
  if (roleFromId === UNDECLARED_GRANT) {
    // An undeclared grant is neutral to every source: only a declared slot may name a grant's
    // role, so the label never classifies it either.
    return { role: 'neutral', hasUndeclaredGrant: true };
  }
  if (roleFromId) return { role: roleFromId, hasUndeclaredGrant: false };
  return { role: classifyAlertButtonRole(label), hasUndeclaredGrant: false };
}

/** The grant-id shape: an id that states an allow or a deny on a permission sheet. */
const ANDROID_GRANT_ID_SHAPE = /(?:^|:)id\/permission_(?:allow|deny)/i;

/** `classifyAndroidAlertButtonById`'s fourth answer: a grant id no slot declares. */
const UNDECLARED_GRANT = 'undeclared-grant' as const;

/**
 * The role a resource id states. A known permissioncontroller id answers from the one slot
 * table that also ranks it; the `android:id/button1..3` positions carry a role Android's dialog
 * owns with no grant to rank. A grant-shaped id no slot declares (a vendor fork's own grant, or
 * a future AOSP grant this build has not learned) answers UNDECLARED_GRANT: it states a grant
 * nothing here ranks, so it carries no role and no label may give it one — the sheet-level
 * refusal in chooseAndroidAlertButton reads that typed fact and presses nothing.
 */
function classifyAndroidAlertButtonById(
  identifier: string,
): AlertButtonRole | typeof UNDECLARED_GRANT | null {
  const slot = permissionGrantIdSlot(identifier);
  if (slot !== -1) return PERMISSION_GRANT_ID_SLOTS[slot]!.role;
  if (/(?:^|:)id\/button1$/i.test(identifier)) return 'accept';
  if (/(?:^|:)id\/button2$/i.test(identifier)) return 'dismiss';
  if (/(?:^|:)id\/button3$/i.test(identifier)) return 'neutral';
  if (ANDROID_GRANT_ID_SHAPE.test(identifier)) return UNDECLARED_GRANT;
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
  return common.at(-1);
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
