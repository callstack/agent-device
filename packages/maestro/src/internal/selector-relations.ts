import type { MaestroSelector } from './program-ir.ts';

/** True when this selector or any nested selector requires snapshot resolution. */
export function hasMaestroRecursiveRelations(selector: MaestroSelector): boolean {
  return (
    selector.index !== undefined ||
    selector.childOf !== undefined ||
    selector.below !== undefined ||
    selector.above !== undefined ||
    selector.leftOf !== undefined ||
    selector.rightOf !== undefined ||
    selector.containsChild !== undefined ||
    selector.containsDescendants !== undefined
  );
}

/** The leaf fields are absent when the selector is an upstream identity filter. */
export function hasMaestroLeafSelectorFields(selector: MaestroSelector): boolean {
  return (
    selector.text !== undefined ||
    selector.id !== undefined ||
    selector.enabled !== undefined ||
    selector.selected !== undefined
  );
}
