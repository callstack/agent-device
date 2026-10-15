import type { AlertInfo, AlertSource } from '@agent-device/contracts/alert-contract';
import { centerOfRect, type Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { readIosNodeChildren, readIosNodeRect, type IosTreeNode } from './snapshot.ts';

/**
 * System-alert detection over a Limrun iOS element tree (issue #3349). A Limrun iOS direct
 * session has no XCUITest runner, but its element tree does carry the system alert: on a live
 * instance the ATT prompt arrives as its own `AXApplication` root whose `AXLabel` is blank, with
 * its text and buttons as direct children all sharing the hosting process's `pid` — never the
 * app's. The app's own `UIAlertController`, by contrast, rides inside the app's root, labeled
 * with the app name and carrying the app's pid. The rules below encode that observed split and
 * refuse everything it does not vouch for: a named root is app UI, launch-icon buttons are a
 * home screen, and a button without a frame or a live `pid` match across visible roots is not
 * pressable. What one live capture cannot exclude — an app that left its own root's label blank
 * while showing a dialog — is why the acting legs press only label-unambiguous buttons below.
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
  /^(?:ok|allow|allow all|allow once|allow all the time|allow while using (?:the )?app|allow notifications|always allow|yes|continue|save|confirm|turn on|open settings|while using the app|only this time)$/i;
// `don.?t allow` covers the straight, missing, and typographic apostrophe in one alternate.
const DISMISS_LABEL_PATTERN =
  /^(?:cancel|deny|don.?t allow|not now|no|dismiss|close|close app|later|skip|ask app not to track)$/i;
/** The subset that states a grant/deny choice; a plain Yes/No dialog is not a permission prompt. */
const PERMISSION_LABEL_PATTERN =
  /^(?:allow.*|deny|don.?t allow|ask app not to track|turn on|open settings)$/i;
/** SpringBoard marks its home-screen icons with this trait; an alert never carries it. */
const LAUNCH_ICON_TRAIT = 'LaunchIcon';

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
 * dialog-shaped: at least two pressable choices (enabled, hittable, with a complete rect), at
 * least one piece of text, and no SpringBoard launch icons. One live capture cannot exclude an
 * app that leaves its own root's label blank while showing a dialog — the provider reports no
 * capture-level fact that separates it from the alert host — which is why the acting legs press
 * only buttons whose label states the asked-for choice, and an alert-shaped sheet offering a
 * single choice is refused entirely rather than acted on by position.
 *
 * The button vocabulary is English, matching the untranslated simulator locale these instances
 * run; a localized alert classifies as undecided and the acting legs report the ambiguity rather
 * than guessing.
 */
export function findLimrunAlertCandidate(
  tree: IosTreeNode | IosTreeNode[],
): LimrunAlertCandidate | null {
  const candidates: LimrunAlertCandidate[] = [];
  for (const root of Array.isArray(tree) ? tree : [tree]) {
    if (!isLimrunAlertHostRoot(root)) continue;
    const candidate = readAlertCandidateFromHostRoot(root);
    if (candidate) candidates.push(candidate);
  }
  // More than one alert-shaped host sheet is a shape this reader does not understand; pressing
  // into it would guess, and the observation would silently shadow one with the other.
  return candidates.length === 1 ? candidates[0]! : null;
}

function readAlertCandidateFromHostRoot(root: IosTreeNode): LimrunAlertCandidate | null {
  const descendants = collectDescendants(root);
  const buttons = findAlertButtons(descendants);
  // A lone choice says nothing about which action the caller asked for; refuse the sheet.
  if (buttons.length < 2) return null;
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
 * Pressable alert choices only: a disabled button is not a choice the alert offers right now, a
 * button without a complete rect has no point the touch seam could aim at, a button the provider
 * reports as unhittable cannot be pressed, and a `LaunchIcon` is a home-screen app icon rather
 * than a dialog button.
 */
function findAlertButtons(nodes: IosTreeNode[]): LimrunAlertButton[] {
  const seen = new Set<string>();
  const buttons: LimrunAlertButton[] = [];
  for (const node of nodes) {
    if (!isButtonNode(node) || node.enabled === false || node.hittable === false) continue;
    if (node.traits?.includes(LAUNCH_ICON_TRAIT)) continue;
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
 * on, only a button whose own label states the asked-for choice may be pressed, and even then
 * only when exactly one choice does — an accept must never press a denial, and an alert whose
 * choices leave the action undecided is refused rather than resolved by tree position.
 */
export function chooseLimrunAlertButton(
  buttons: readonly LimrunAlertButton[],
  action: 'accept' | 'dismiss',
): LimrunAlertButton | null {
  const wanted = action === 'accept' ? 'accept' : 'dismiss';
  const matching = buttons.filter((button) => button.role === wanted);
  return matching.length === 1 ? matching[0]! : null;
}
