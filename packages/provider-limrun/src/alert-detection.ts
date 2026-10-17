import {
  type AlertButtonRole,
  classifyAlertButtonRole,
  type AlertInfo,
  type AlertSource,
  selectRankedAlertButtonByRole,
} from '@agent-device/contracts/alert-contract';
import { centerOfRect, type Rect } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { TreeAlertObservation } from '@agent-device/capture-kit/alert-tree-driver';
import { readIosNodeChildren, readIosNodeRect, type IosTreeNode } from './snapshot.ts';

/**
 * System-alert detection over a Limrun iOS element tree (issue #3349). A Limrun iOS direct
 * session has no XCUITest runner, but its element tree carries the system alert: on a live
 * instance the ATT prompt arrived as its own `AXApplication` root with a blank `AXLabel` and one
 * `pid` shared by its whole subtree — never the app's. The app's own `UIAlertController` rode
 * inside the app's named root under the app's pid. Nothing in a capture names an owner, so the
 * host rule is a stated heuristic: a host sheet qualifies only on a blank-label root reporting a
 * `pid` whose entire subtree reports that same one. The named residual these captures cannot
 * exclude: an app blanking its own root label while showing an unshared dialog — the acting legs
 * press only label-unambiguous buttons as the backstop. Button eligibility never asserts
 * hitability: captures omit `hittable` entirely, so an explicit `false` refuses and an omission
 * carries no signal; enabled, label, and complete-rect rules admit a button.
 */

/** Only the two host-sheet sources exist on this surface: no node names a package to attribute. */
type LimrunAlertSource = Extract<AlertSource, 'permission' | 'system-dialog'>;

export type LimrunAlertButton = Readonly<{
  label: string;
  x: number;
  y: number;
  role: AlertButtonRole;
}>;

export type LimrunAlertInfo = AlertInfo & {
  buttons: string[];
  platform: 'ios';
  source: LimrunAlertSource;
};

export type LimrunAlertCandidate = Readonly<{
  alert: LimrunAlertInfo;
  buttons: LimrunAlertButton[];
}>;

// The button roles come from the shared tree-alert label vocabulary in contracts/alert-contract:
// the same label states the same role on Android and here, so `alert dismiss` cannot act
// differently on the two platforms for one label. English-only, matching the untranslated
// device locale these instances run; a localized alert resolves as a candidate whose buttons
// all classify neutral, and the acting legs refuse on the button-undecided reason.
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
 * The one capture reader: what this element tree says about system alerts, in the shared
 * tree-alert observation the driver confirms against. `none` states the capture carries no
 * alert-shaped content on any host root; `undecided` states it carries alert-shaped content this
 * reader cannot resolve into one actionable alert — more than one alert-shaped host sheet, or a
 * sheet whose choices are visible yet unactionable (a degraded or shared root). Only `alert` and
 * `none` carry information; `undecided` is not absence, and confirming a dismissal may accept
 * `none` but never `undecided`.
 */
export type LimrunAlertCapture = TreeAlertObservation<LimrunAlertCandidate>;

/**
 * The actionable alert on this capture, or why the capture answers nothing. A host sheet is
 * actionable only on a blank-label, process-exclusive root (it reports a `pid` and its whole
 * subtree reports that same one) offering at least two pressable choices (enabled, not reported
 * unhittable, with a complete rect and a label) under at least one piece of text, with no
 * SpringBoard launch icons. A root that shows the same dialog-shaped content but fails one of
 * those tests — a button dropping to unhittable, disabled, frameless, or label-less between
 * captures, a root sharing its subtree with another pid — still shows a dialog, so the capture
 * is undecided, not absent. A named root is app UI, a home screen offers launch icons, and a
 * blank root with neither a message nor a pair of button-shaped nodes carries nothing a dialog
 * could have degraded from: those are absence. What these captures cannot exclude is an app
 * dialog under a blanked root no other process rides; the label-strict acting legs are the
 * backstop named above.
 */
export function readLimrunAlertCapture(tree: IosTreeNode | IosTreeNode[]): LimrunAlertCapture {
  let candidate: LimrunAlertCandidate | null = null;
  let alertShapedRoots = 0;
  for (const root of Array.isArray(tree) ? tree : [tree]) {
    if (!isLimrunAlertHostRoot(root)) continue;
    const observed = readAlertHostRoot(root);
    if (observed === 'absent') continue;
    alertShapedRoots += 1;
    if (observed !== 'undecided') candidate = observed;
  }
  // One actionable sheet among nothing else alert-shaped is the answer. Two sheets, or one that
  // is alert-shaped yet unactionable, is content this reader must not resolve by guessing —
  // pressing into it would pick a side the observation does not support.
  if (alertShapedRoots === 0) return { kind: 'none' };
  return alertShapedRoots === 1 && candidate ? { kind: 'alert', candidate } : { kind: 'undecided' };
}

type LimrunHostRootReading = LimrunAlertCandidate | 'undecided' | 'absent';

function readAlertHostRoot(root: IosTreeNode): LimrunHostRootReading {
  const descendants = collectDescendants(root);
  // A home screen is a home screen: SpringBoard marks its icons, and widgets can carry text,
  // so the trait answers absence before any dialog question is asked.
  if (descendants.some(isLaunchIcon)) return 'absent';
  const texts = descendants
    .filter(isStaticTextNode)
    .map(nodeLabel)
    .filter((text) => text.length > 0);
  const choices = descendants.filter((node) => isButtonNode(node) && !isLaunchIcon(node));
  // Absence means nothing a dialog could have degraded from: no message and no pair of
  // button-shaped nodes.
  if (texts.length === 0 && choices.length < 2) return 'absent';
  // Process exclusivity is the capture-side host heuristic named above: the live system alert
  // root was process-exclusive (one pid on every node) while the app root rode SpringBoard's
  // status nodes under a second pid. It settles actionability, never absence.
  const exclusive =
    typeof root.pid === 'number' && descendants.every((node) => node.pid === root.pid);
  if (!exclusive) return 'undecided';
  const buttons = findAlertButtons(descendants);
  // Dialog-shaped content that is not actionable — a sheet rendered mid-transition, one whose
  // buttons just dropped to disabled, unhittable, or frameless, a message-less button pair —
  // still shows something alert-shaped. That is undecided, never absence, so no caller can
  // report it as a confirmed no-alert.
  if (texts.length === 0 || buttons.length < 2) return 'undecided';
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

function isLaunchIcon(node: IosTreeNode): boolean {
  return node.traits?.includes(LAUNCH_ICON_TRAIT) === true;
}

function isStaticTextNode(node: IosTreeNode): boolean {
  return node.role === 'AXStaticText' || node.type === 'StaticText';
}

/**
 * Pressable alert choices only: a disabled button is not a choice the alert offers right now, a
 * button without a complete rect has no point the touch seam could aim at, and a button the
 * provider explicitly reports as `hittable: false` cannot be pressed; an omitted `hittable`
 * carries no signal either way. Process membership was settled by the caller, so every physical
 * node stays in the list: two buttons sharing a label are two points a tap could land on, and
 * the chooser refuses rather than taking the first.
 */
function findAlertButtons(nodes: IosTreeNode[]): LimrunAlertButton[] {
  const buttons: LimrunAlertButton[] = [];
  for (const node of nodes) {
    if (!isButtonNode(node) || node.enabled === false || node.hittable === false) continue;
    const label = nodeLabel(node);
    if (!label) continue;
    const rect = readIosNodeRect(node);
    if (!isPressableRect(rect)) continue;
    const point = centerOfRect(rect);
    buttons.push({ label, x: point.x, y: point.y, role: classifyAlertButtonRole(label) });
  }
  return buttons;
}

function isPressableRect(rect: Rect | undefined): rect is Rect {
  return isPositiveFiniteRect(rect);
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
 * on, only a button whose own label states the asked-for choice may be pressed, resolved through
 * the shared preference table — a multi-grant sheet ("Allow Once" / "Allow While Using App" /
 * "Don't Allow") resolves to the preferred grant, while equal-rank labels or a vocabulary-free
 * multiplicity refuse. An accept must never press a denial, and an undecided action is refused
 * rather than resolved by tree position.
 */
export function chooseLimrunAlertButton(
  buttons: readonly LimrunAlertButton[],
  action: 'accept' | 'dismiss',
): LimrunAlertButton | null {
  return selectRankedAlertButtonByRole(buttons, action);
}
