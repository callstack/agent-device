import type { CloudTextEntryReadiness } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import { type Rect } from '@agent-device/kernel/snapshot';
import { containsPoint, isPositiveFiniteRect, rectArea } from '@agent-device/kernel/rect';
import { readIosNodeChildren, readIosNodeRect, type IosTreeNode } from './snapshot.ts';

/**
 * The accessibility trait the Limrun iOS instance puts on the one element that
 * owns text entry. It is how this provider can answer "which element is editing"
 * per node, which its `typeText` focus scan cannot: an app that never reports a
 * global focused element (#2578's Flutter form) still marks its editing field
 * with this trait.
 */
const LIMRUN_IOS_TEXT_ENTRY_TRAIT = 'IsEditing';

/**
 * How long a tapped field gets to appear as the editing element. Longer than the
 * Apple runner's or the cloud-WebDriver budget because every sample here is a
 * round trip to the instance rather than a local read.
 */
const TEXT_ENTRY_FOCUS_TIMEOUT_MS = 3_000;
const TEXT_ENTRY_FOCUS_POLL_INTERVAL_MS = 150;

/**
 * The element that owns text entry, as one tree read saw it. The rect is
 * required because it is what the witness is made of: an element that reports no
 * usable frame cannot be shown to be the one that was tapped, and so is not
 * offered as evidence at all.
 */
export type LimrunTextEntryFocus = Readonly<{
  identity: string;
  rect: Rect;
}>;

/**
 * Nothing took text-entry focus within the budget, so typing would go to
 * whatever else holds first responder — or nowhere. #1658 is precisely the report
 * of that being answered with "Filled N chars", so this fails instead of typing.
 * `editingElementObserved` separates a target that never exposes text entry from
 * one that exposed it somewhere other than where we tapped, which are different
 * next moves for the caller.
 */
function textEntryFocusNotObservedError(
  x: number,
  y: number,
  detail: string,
  evidence: Readonly<{ samples: number; editingElementObserved: boolean }>,
): AppError {
  return new AppError('COMMAND_FAILED', `fill tapped (${x}, ${y}) but ${detail}`, {
    reason: 'text_entry_focus_not_observed',
    x,
    y,
    ...evidence,
    hint: 'The tap most likely missed the field. Re-check the target with snapshot -i and fill the element it reports, rather than retrying the same coordinates.',
  });
}

/**
 * The editing element of one tree read. A field and its container can both carry
 * the trait, so the smallest one with a usable rect wins: it is the node whose
 * geometry can witness a point.
 */
export function readLimrunTextEntryFocus(
  tree: IosTreeNode | IosTreeNode[],
): LimrunTextEntryFocus | null {
  let focus: LimrunTextEntryFocus | null = null;
  let focusArea = Number.POSITIVE_INFINITY;
  for (const node of flattenIosNodes(tree)) {
    if (!node.traits?.includes(LIMRUN_IOS_TEXT_ENTRY_TRAIT)) continue;
    const rect = readIosNodeRect(node);
    if (!isPositiveFiniteRect(rect)) continue;
    const area = rectArea(rect);
    if (area >= focusArea) continue;
    focus = { identity: limrunTextEntryIdentity(node), rect };
    focusArea = area;
  }
  return focus;
}

/**
 * The elements this fill aimed at, read before the tap could move anything. An
 * editing element among them was under the finger even if focusing it re-laid it
 * out or a keyboard scrolled it away, which is what lets a fill vouch for a field
 * that moved while refusing one that was never there.
 *
 * An identity the tree reports more than once is left out rather than trusted. Two
 * fields that expose neither an identifier nor a label share every part this
 * identity is built from, so trusting it would let a fill replace whichever twin
 * holds focus. Geometry still witnesses such a field when the tap lands on it,
 * because only geometry can tell two twins apart.
 */
export function readLimrunUnambiguousTapTargets(
  tree: IosTreeNode | IosTreeNode[],
  x: number,
  y: number,
): ReadonlySet<string> {
  const framed: Array<Readonly<{ identity: string; rect: Rect }>> = [];
  for (const node of flattenIosNodes(tree)) {
    const rect = readIosNodeRect(node);
    if (isPositiveFiniteRect(rect)) framed.push({ identity: limrunTextEntryIdentity(node), rect });
  }
  const sightings = new Map<string, number>();
  for (const node of framed) {
    sightings.set(node.identity, (sightings.get(node.identity) ?? 0) + 1);
  }
  const targets = new Set<string>();
  for (const node of framed) {
    if (sightings.get(node.identity) === 1 && containsPoint(node.rect, x, y)) {
      targets.add(node.identity);
    }
  }
  return targets;
}

/**
 * Wait for the tap to move text-entry focus, then hand back the evidence this
 * fill earned. Geometry is what the claim is made of: the editing element either
 * still covers the point we aimed at, or it was among the elements that did when
 * we read the screen before tapping. An editing element elsewhere on the screen
 * says nothing about this tap, and typing into it is the misdelivery #1658 was
 * reported as, so it is refused instead.
 *
 * Limrun exposes this one route and no keyboard-visibility route, so a field that
 * never takes the editing trait is indistinguishable from a tap that missed: the
 * fill is refused rather than answered with text typed into the dark.
 */
export async function awaitLimrunTextEntryFocus(
  params: Readonly<{
    targetsAtPoint: ReadonlySet<string>;
    readFocus: () => Promise<LimrunTextEntryFocus | null>;
    sleep: (milliseconds: number) => Promise<void>;
    x: number;
    y: number;
    timeoutMs?: number;
  }>,
): Promise<CloudTextEntryReadiness> {
  const deadline = Date.now() + (params.timeoutMs ?? TEXT_ENTRY_FOCUS_TIMEOUT_MS);
  let samples = 0;
  let editingElementObserved = false;
  for (;;) {
    const focus = await params.readFocus();
    samples += 1;
    if (focus) {
      editingElementObserved = true;
      if (witnessesThisTap(focus, params.targetsAtPoint, params.x, params.y)) {
        return 'focused-element';
      }
    }
    if (Date.now() >= deadline) break;
    await params.sleep(TEXT_ENTRY_FOCUS_POLL_INTERVAL_MS);
  }
  throw textEntryFocusNotObservedError(
    params.x,
    params.y,
    'nothing there took text-entry focus, so the text was not sent',
    { samples, editingElementObserved },
  );
}

function witnessesThisTap(
  focus: LimrunTextEntryFocus,
  targetsAtPoint: ReadonlySet<string>,
  x: number,
  y: number,
): boolean {
  return containsPoint(focus.rect, x, y) || targetsAtPoint.has(focus.identity);
}

function flattenIosNodes(tree: IosTreeNode | IosTreeNode[]): IosTreeNode[] {
  const nodes: IosTreeNode[] = [];
  const visit = (node: IosTreeNode) => {
    nodes.push(node);
    for (const child of readIosNodeChildren(node)) visit(child);
  };
  for (const root of Array.isArray(tree) ? tree : [tree]) visit(root);
  return nodes;
}

/**
 * What two reads of the same element agree on. Identity rather than a handle:
 * the provider hands out no element id, and the process plus the accessibility
 * identity and label a field exposes is stable across the reads a fill takes.
 */
function limrunTextEntryIdentity(node: IosTreeNode): string {
  return [
    node.pid ?? '',
    node.type ?? node.elementType ?? '',
    node.AXUniqueId ?? node.identifier ?? '',
    node.AXLabel ?? node.label ?? '',
  ].join('\u0000');
}
