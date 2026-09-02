import { refuse, type SelectorArgumentRefusal } from './argument-refusal.ts';

import { IS_PREDICATES, type IsPredicate } from '@agent-device/contracts/is-predicate';
import type { Platform, PublicPlatform } from '@agent-device/kernel/device';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import {
  createSnapshotVisibility,
  extractNodeText,
  isUsefulVisibilityAnchor,
  type SnapshotVisibility,
} from '@agent-device/contracts/snapshot';
import { isNodeEditable, isNodeVisible } from './node.ts';
import { tryParseSelectorChain } from './parse.ts';

export type { IsPredicate } from '@agent-device/contracts/is-predicate';

// Module-private since `checkIsPredicate` became the admission API: a caller that tests the
// vocabulary without going through admission is how the case-normalization drift started.
function isSupportedPredicate(input: string): input is IsPredicate {
  return (IS_PREDICATES as readonly string[]).includes(input);
}

export const IS_PREDICATE_REQUIRED_MESSAGE = `is requires predicate: ${IS_PREDICATES.join('|')}`;

/**
 * The one `is` predicate admission check. Three call sites used to state this rule
 * independently — the daemon handler (with the usage hint), `commands/interaction/selectors.ts`
 * (with its own inlined seven-way predicate list) and `isCommand` (without the hint) — so the
 * same mistake got recovery guidance or not depending on which layer noticed it first, and the
 * predicate list existed twice.
 */
export function checkIsPredicate(
  raw: string,
): { ok: true; predicate: IsPredicate } | SelectorArgumentRefusal {
  const predicate = raw.toLowerCase();
  if (!isSupportedPredicate(predicate)) {
    return refuse(IS_PREDICATE_REQUIRED_MESSAGE, IS_PREDICATE_USAGE_HINT);
  }
  return { ok: true, predicate };
}

export const IS_PREDICATE_USAGE_HINT =
  'Use "is <predicate> <selector>" or "is <selector> <predicate>". visible|hidden|editable|selected|focused double as selector keys: a bare predicate token after the selector is read as the predicate, so write key=true (e.g. visible=true) inside the selector to use it as a filter instead.';

// visible|hidden|editable|selected|focused double as selector boolean keys, so the selector-first
// form (`is <selector> <predicate>`) cannot survive greedy selector parsing: the trailing
// predicate token would be swallowed as a boolean selector term. Reserve the first bare
// predicate token that terminates a valid selector prefix and rotate the positionals into
// the canonical predicate-first shape.
export function normalizeIsPositionals(positionals: string[]): string[] {
  if (isSupportedPredicate((positionals[0] ?? '').toLowerCase())) return positionals;
  for (let i = 1; i < positionals.length; i += 1) {
    const candidate = (positionals[i] ?? '').toLowerCase();
    if (!isSupportedPredicate(candidate)) continue;
    if (!tryParseSelectorChain(positionals.slice(0, i).join(' '))) continue;
    return [candidate, ...positionals.slice(0, i), ...positionals.slice(i + 1)];
  }
  return positionals;
}

export function evaluateIsPredicate(params: {
  predicate: Exclude<IsPredicate, 'exists' | 'absent'>;
  node: SnapshotState['nodes'][number];
  nodes: SnapshotState['nodes'];
  expectedText?: string;
  platform: Platform | PublicPlatform;
}): { pass: boolean; actualText: string; details: string } {
  const { predicate, node, nodes, expectedText, platform } = params;
  const actualText = extractNodeText(node);
  const editable = isNodeEditable(node, platform);
  const selected = node.selected === true;
  const focused = node.focused === true;
  const visible =
    predicate === 'text'
      ? isNodeVisible(node)
      : isAssertionVisible(node, createSnapshotVisibility(nodes), platform);
  let pass = false;
  switch (predicate) {
    case 'visible':
      pass = visible;
      break;
    case 'hidden':
      pass = !visible;
      break;
    case 'editable':
      pass = editable;
      break;
    case 'selected':
      pass = selected;
      break;
    case 'focused':
      pass = focused;
      break;
    case 'text':
      pass = actualText === (expectedText ?? '');
      break;
    default:
      return assertNever(predicate);
  }
  const details =
    predicate === 'text'
      ? `expected="${expectedText ?? ''}" actual="${actualText}"`
      : `actual=${JSON.stringify({
          visible,
          editable,
          selected,
          focused,
        })}`;
  return { pass, actualText, details };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled is predicate: ${String(value)}`);
}

function isAssertionVisible(
  node: SnapshotState['nodes'][number],
  visibility: SnapshotVisibility,
  platform: Platform | PublicPlatform,
): boolean {
  if (platform === 'android' && node.visibleToUser === false) return false;
  if (isPositiveFiniteRect(node.rect)) return visibility.isVisibleInEffectiveViewport(node);
  if (node.rect) return false;
  if (platform !== 'android' && node.hittable === true) return true;
  const anchor = resolveVisibilityAnchor(node, visibility, platform);
  if (!anchor) return false;
  if (!isPositiveFiniteRect(anchor.rect)) return platform !== 'android' && anchor.hittable === true;
  return visibility.isVisibleInEffectiveViewport(anchor);
}

function resolveVisibilityAnchor(
  node: SnapshotState['nodes'][number],
  visibility: SnapshotVisibility,
  platform: Platform | PublicPlatform,
): SnapshotState['nodes'][number] | null {
  return visibility.findAncestor(node, (parent) =>
    isUsefulVisibilityAnchor(parent, platform) ? parent : null,
  );
}
