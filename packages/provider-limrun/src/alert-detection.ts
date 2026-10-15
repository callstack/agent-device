import type { AlertInfo, AlertSource } from '@agent-device/contracts/alert-contract';
import { centerOfRect, type Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { readIosNodeChildren, readIosNodeRect, type IosTreeNode } from './snapshot.ts';

/**
 * System-alert detection over a Limrun iOS element tree (issue #3349). A Limrun iOS direct
 * session has no XCUITest runner, but its element tree does carry the system alert: on a live
 * instance the ATT prompt arrives as its own `AXApplication` root whose `AXLabel` is blank and
 * whose content nodes carry the hosting process's `pid` — not the app's. The app's own
 * `UIAlertController`, by contrast, rides inside the app's root, labeled with the app name and
 * carrying the app's pid. The rules below encode exactly that observed split; they are
 * conservative in both directions and every shape here is pinned to the live captures.
 */

type LimrunAlertButtonRole = 'accept' | 'dismiss' | 'neutral';

export type LimrunAlertButton = Readonly<{
  label: string;
  x: number;
  y: number;
  role: LimrunAlertButtonRole;
}>;

/** Only the two host-sheet sources exist on this surface: no node names a package to attribute. */
type LimrunAlertSource = Extract<AlertSource, 'permission' | 'system-dialog'>;

export type LimrunAlertInfo = AlertInfo & {
  buttons: string[];
  platform: 'ios';
  source: LimrunAlertSource;
};

export type LimrunAlertCandidate = Readonly<{
  alert: LimrunAlertInfo;
  buttons: LimrunAlertButton[];
}>;

const ACCEPT_LABEL_PATTERN =
  /^(?:ok|allow|allow all|always allow|yes|continue|save|confirm|turn on|open settings)$/i;
const DISMISS_LABEL_PATTERN =
  /^(?:cancel|deny|don.?t allow|don’t allow|don.t allow|not now|no|dismiss|close|later|skip|ask app not to track)$/i;
/** The subset that states a grant/deny choice; a plain Yes/No dialog is not a permission prompt. */
const PERMISSION_LABEL_PATTERN =
  /^(?:allow.*|always allow|deny|don.?t allow|don’t allow|don.t allow|ask app not to track|turn on|open settings)$/i;

function nodeLabel(node: IosTreeNode): string {
  const label = node.AXLabel ?? node.label;
  return typeof label === 'string' ? label.trim() : '';
}

/**
 * The application root a system alert arrives on: the blank-label `AXApplication`. An app names
 * its own root, so a labeled application is the app's scene — including when it hosts an
 * in-app `UIAlertController` — and never a system host. SpringBoard also reports a blank label;
 * its screens are refused downstream because they carry no dialog-shaped content.
 */
export function isLimrunAlertHostRoot(node: IosTreeNode): boolean {
  if (node.role !== 'AXApplication' && node.type !== 'Application') return false;
  return nodeLabel(node).length === 0;
}

/**
 * The actionable alert on this capture, or null. A host root qualifies only when its content is
 * dialog-shaped: a button that can actually be pressed (enabled, with a complete rect) and at
 * least one piece of text or another button beside it. That refusals both an app dialog (wrong
 * root) and SpringBoard's home screen (blank root, launch icons instead of a dialog).
 */
export function findLimrunAlertCandidate(
  tree: IosTreeNode | IosTreeNode[],
): LimrunAlertCandidate | null {
  for (const root of Array.isArray(tree) ? tree : [tree]) {
    if (!isLimrunAlertHostRoot(root)) continue;
    const candidate = readAlertCandidateFromHostRoot(root);
    if (candidate) return candidate;
  }
  return null;
}

function readAlertCandidateFromHostRoot(root: IosTreeNode): LimrunAlertCandidate | null {
  const descendants = collectDescendants(root);
  const buttons = findAlertButtons(descendants);
  if (buttons.length === 0) return null;
  const texts = descendants
    .filter((node) => isStaticTextNode(node) && !isButtonNode(node))
    .map(nodeLabel)
    .filter((text) => text.length > 0);
  // A dialog says something: SpringBoard's blank-label home screen offers launch icons, not a
  // message with a choice, and stays unreported.
  if (texts.length === 0) return null;
  const [title, ...rest] = texts;
  const alert: LimrunAlertInfo = {
    ...(title ? { title } : {}),
    ...(rest.length > 0 ? { message: [...new Set(rest)].join('\n') } : {}),
    buttons: buttons.map((button) => button.label),
    platform: 'ios',
    source: classifyAlertSource(buttons),
  };
  return { alert, buttons };
}

function collectDescendants(root: IosTreeNode): IosTreeNode[] {
  const nodes: IosTreeNode[] = [];
  const visit = (node: IosTreeNode) => {
    for (const child of readIosNodeChildren(node)) {
      nodes.push(child);
      visit(child);
    }
  };
  visit(root);
  return nodes;
}

function isButtonNode(node: IosTreeNode): boolean {
  return node.role === 'AXButton' || node.type === 'Button';
}

function isStaticTextNode(node: IosTreeNode): boolean {
  return node.role === 'AXStaticText' || node.type === 'StaticText';
}

/**
 * Pressable buttons only: a disabled button is not a choice the alert offers right now, and a
 * button without a complete rect has no point the touch seam could aim at.
 */
function findAlertButtons(nodes: IosTreeNode[]): LimrunAlertButton[] {
  const seen = new Set<string>();
  const buttons: LimrunAlertButton[] = [];
  for (const node of nodes) {
    if (!isButtonNode(node) || node.enabled === false) continue;
    const label = nodeLabel(node);
    if (!label || seen.has(label.toLowerCase())) continue;
    const rect = readIosNodeRect(node);
    if (!isPressableRect(rect)) continue;
    seen.add(label.toLowerCase());
    const point = centerOfRect(rect);
    buttons.push({ label, x: point.x, y: point.y, role: classifyAlertButton(label) });
  }
  return buttons;
}

function isPressableRect(rect: Rect | undefined): rect is Rect {
  return isPositiveFiniteRect(rect);
}

function classifyAlertButton(label: string): LimrunAlertButtonRole {
  const trimmed = label.trim();
  if (ACCEPT_LABEL_PATTERN.test(trimmed)) return 'accept';
  if (DISMISS_LABEL_PATTERN.test(trimmed)) return 'dismiss';
  return 'neutral';
}

/** A button vocabulary naming a grant/deny choice makes this a permission prompt. */
function classifyAlertSource(buttons: readonly LimrunAlertButton[]): LimrunAlertSource {
  return buttons.some((button) => PERMISSION_LABEL_PATTERN.test(button.label.trim()))
    ? 'permission'
    : 'system-dialog';
}

/**
 * The button one action may press, or null when pressing any visible choice would guess.
 * Deliberately stricter than Android's: with no `android:id/button1`-style identity to fall back
 * on, only a button whose own label states the asked-for choice may be pressed — an accept must
 * never press a denial, and an alert whose choices are all neutral is refused for both actions
 * rather than resolved by position.
 */
export function chooseLimrunAlertButton(
  buttons: readonly LimrunAlertButton[],
  action: 'accept' | 'dismiss',
): LimrunAlertButton | null {
  const wanted = action === 'accept' ? 'accept' : 'dismiss';
  return buttons.find((button) => button.role === wanted) ?? null;
}
