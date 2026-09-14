import type { CloudTextEntryReadiness } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import { type Rect } from '@agent-device/kernel/snapshot';
import { containsPoint, isPositiveFiniteRect, rectArea } from '@agent-device/kernel/rect';
import { readIosNodeChildren, readIosNodeRect, type IosTreeNode } from './snapshot.ts';

/** The trait a Limrun iOS instance puts on the element that owns text entry. */
const LIMRUN_IOS_TEXT_ENTRY_TRAIT = 'IsEditing';

/** Each sample is a round trip to the instance, so this budget is longer than a local read's. */
const TEXT_ENTRY_FOCUS_TIMEOUT_MS = 3_000;
const TEXT_ENTRY_FOCUS_POLL_INTERVAL_MS = 150;

/**
 * The element that owns text entry, as one tree read saw it. A rect is required: an
 * element without a usable frame cannot be shown to be the one that was tapped. The
 * identity is offered only when that read reports it once, because an identity two
 * elements share cannot say which of them holds focus.
 */
export type LimrunTextEntryFocus = Readonly<{
  identity?: string;
  rect: Rect;
}>;

/**
 * Nothing took text-entry focus within the budget, so typing would go to whatever
 * else holds first responder, or nowhere. `editingElementObserved` separates a
 * target that never exposes text entry from one that exposed it away from the
 * tapped point, which are different next moves for the caller.
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

/** A node with a rect a point can be tested against, which is what a witness needs. */
type LimrunFramedNode = Readonly<{ node: IosTreeNode; identity: string; rect: Rect }>;

function readFramedNodes(tree: IosTreeNode | IosTreeNode[]): LimrunFramedNode[] {
  const framed: LimrunFramedNode[] = [];
  for (const node of flattenIosNodes(tree)) {
    const rect = readIosNodeRect(node);
    if (isPositiveFiniteRect(rect)) {
      framed.push({ node, identity: limrunTextEntryIdentity(node), rect });
    }
  }
  return framed;
}

/** How many nodes of one read an identity names. One means the identity picks out a single element. */
function countIdentitySightings(framed: readonly LimrunFramedNode[]): Map<string, number> {
  const sightings = new Map<string, number>();
  for (const entry of framed) {
    sightings.set(entry.identity, (sightings.get(entry.identity) ?? 0) + 1);
  }
  return sightings;
}

/**
 * The editing element of one tree read. A field and its container can both carry the
 * trait, so the smallest rect wins.
 */
export function readLimrunTextEntryFocus(
  tree: IosTreeNode | IosTreeNode[],
): LimrunTextEntryFocus | null {
  const framed = readFramedNodes(tree);
  const sightings = countIdentitySightings(framed);
  let focus: LimrunTextEntryFocus | null = null;
  let focusArea = Number.POSITIVE_INFINITY;
  for (const entry of framed) {
    if (!entry.node.traits?.includes(LIMRUN_IOS_TEXT_ENTRY_TRAIT)) continue;
    const area = rectArea(entry.rect);
    if (area >= focusArea) continue;
    focus =
      sightings.get(entry.identity) === 1
        ? { identity: entry.identity, rect: entry.rect }
        : { rect: entry.rect };
    focusArea = area;
  }
  return focus;
}

/**
 * The elements under the point this fill aims at, read before the tap could move
 * anything, so a field that focusing re-laid out is still recognized. An identity
 * this read reports more than once is left out, and the post-tap read repeats the
 * same check: an element that appears after the tap can share an identity with the
 * one that was under the finger.
 */
export function readLimrunUnambiguousTapTargets(
  tree: IosTreeNode | IosTreeNode[],
  x: number,
  y: number,
): ReadonlySet<string> {
  const framed = readFramedNodes(tree);
  const sightings = countIdentitySightings(framed);
  const targets = new Set<string>();
  for (const entry of framed) {
    if (sightings.get(entry.identity) === 1 && containsPoint(entry.rect, x, y)) {
      targets.add(entry.identity);
    }
  }
  return targets;
}

/**
 * Wait for the tap to move text-entry focus onto the aimed-at point, and hand back
 * the readiness this fill earned. An editing element elsewhere on the screen says
 * nothing about this tap, so it is refused. Limrun reports no keyboard visibility,
 * so a field that never takes the editing trait is indistinguishable from a missed
 * tap.
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
  if (containsPoint(focus.rect, x, y)) return true;
  return focus.identity !== undefined && targetsAtPoint.has(focus.identity);
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

/** What two reads of the same element agree on. The provider hands out no element handle. */
function limrunTextEntryIdentity(node: IosTreeNode): string {
  return [
    node.pid ?? '',
    node.type ?? node.elementType ?? '',
    node.AXUniqueId ?? node.identifier ?? '',
    node.AXLabel ?? node.label ?? '',
  ].join('\u0000');
}
