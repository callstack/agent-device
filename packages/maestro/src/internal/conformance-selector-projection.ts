import type { MaestroGestureTarget, MaestroSelector } from './program-ir.ts';
import { asRecord, bool, dropUndefined, numLike, str } from './conformance-value-coercion.ts';

export type CanonicalSelector = {
  text?: string;
  id?: string;
  index?: number | string;
  enabled?: boolean;
  selected?: boolean;
  childOf?: CanonicalSelector;
  below?: CanonicalSelector;
  above?: CanonicalSelector;
  leftOf?: CanonicalSelector;
  rightOf?: CanonicalSelector;
  containsChild?: CanonicalSelector;
  containsDescendants?: CanonicalSelector[];
};

export type CanonicalTarget = {
  selector?: CanonicalSelector;
  point?: CanonicalPoint;
};

export type CanonicalPoint = { x: number; y: number; unit: 'px' | 'percent'; expr?: string };

/** Project an upstream point string without letting an unhandled shape disappear. */
export function canonicalizeUpstreamPoint(value: unknown): CanonicalPoint | undefined {
  const text = str(value);
  if (!text) return undefined;
  const match = /^\s*(-?\d+)(%?)\s*,\s*(-?\d+)(%?)\s*$/.exec(text);
  if (!match) {
    throw new Error(
      `Cannot canonicalize upstream point ${JSON.stringify(text)}; extend the conformance projection.`,
    );
  }
  const unit = match[2] === '%' || match[4] === '%' ? 'percent' : 'px';
  return { x: Number(match[1]), y: Number(match[3]), unit };
}

export function canonicalizeAgentPoint(coordinate: {
  space: 'absolute' | 'percent';
  x: number;
  y: number;
}): CanonicalPoint {
  return {
    x: coordinate.x,
    y: coordinate.y,
    unit: coordinate.space === 'percent' ? 'percent' : 'px',
  };
}

/** Project an upstream selector model without importing its command model. */
export function canonicalizeUpstreamSelector(value: unknown): CanonicalSelector | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return dropUndefined({
    text: str(record.textRegex),
    id: str(record.idRegex),
    index: numLike(record.index) ?? str(record.index),
    enabled: bool(record.enabled),
    selected: bool(record.selected),
    childOf: canonicalizeUpstreamSelector(record.childOf),
    below: canonicalizeUpstreamSelector(record.below),
    above: canonicalizeUpstreamSelector(record.above),
    leftOf: canonicalizeUpstreamSelector(record.leftOf),
    rightOf: canonicalizeUpstreamSelector(record.rightOf),
    containsChild: canonicalizeUpstreamSelector(record.containsChild),
    containsDescendants: arraySelectors(record.containsDescendants),
  });
}

/** Project an agent-device gesture target while keeping selector identity separate from metadata. */
export function canonicalizeAgentTarget(target: MaestroGestureTarget): CanonicalTarget {
  if (target.space === 'target') {
    return {
      selector: dropUndefined({
        ...canonicalizeAgentSelector(target.selector),
      }),
    };
  }
  return {
    point: { x: target.x, y: target.y, unit: target.space === 'percent' ? 'percent' : 'px' },
  };
}

/** Project an agent-device selector and its optional child relation. */
export function canonicalizeAgentSelector(
  selector: MaestroSelector | undefined,
): CanonicalSelector | undefined {
  if (!selector) return undefined;
  return dropUndefined({
    text: selector.text,
    id: selector.id,
    enabled: selector.enabled,
    selected: selector.selected,
    index: selector.index,
    childOf: canonicalizeAgentSelector(selector.childOf),
    below: canonicalizeAgentSelector(selector.below),
    above: canonicalizeAgentSelector(selector.above),
    leftOf: canonicalizeAgentSelector(selector.leftOf),
    rightOf: canonicalizeAgentSelector(selector.rightOf),
    containsChild: canonicalizeAgentSelector(selector.containsChild),
    containsDescendants: selector.containsDescendants
      ?.map(canonicalizeAgentSelector)
      .filter((item): item is CanonicalSelector => item !== undefined),
  });
}
function arraySelectors(value: unknown): CanonicalSelector[] | undefined {
  return Array.isArray(value)
    ? value
        .map((item) => canonicalizeUpstreamSelector(item))
        .filter((item): item is CanonicalSelector => item !== undefined)
    : undefined;
}
