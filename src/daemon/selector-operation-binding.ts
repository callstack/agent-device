import type { TypeTextBackendResult } from '@agent-device/contracts/interactor-types';
import type {
  ElementTextRuntimeOperations,
  ReadTextAtPointInput,
} from '@agent-device/contracts/element-text-runtime';
import type { FocusPointInput } from '@agent-device/contracts/focus-runtime';
import type { TypeTextInput } from '@agent-device/contracts/type-text-runtime';
import type {
  FindSelectorInput,
  FindSelectorRuntimeOperations,
  FindTextInput,
  FindTextRuntimeOperations,
} from '@agent-device/contracts/selector-observation-runtime';

export type BoundElementRead = ElementTextRuntimeOperations['readTextAtPoint'];
export type BoundNativeTextRead = FindTextRuntimeOperations['findText'];
export type BoundNativeSelectorRead = FindSelectorRuntimeOperations['findSelector'];

type SelectorOperations = Readonly<{
  readTextAtPoint?: BoundElementRead;
  findText?: BoundNativeTextRead;
  findSelector?: BoundNativeSelectorRead;
}>;

/** Projects the one preferred operation admitted for `get` and read-only `find`. */
export function selectElementTextOperation(
  runtime: Readonly<{
    operations: Readonly<{ readTextAtPoint?: BoundElementRead }>;
  }>,
): Pick<SelectorOperations, 'readTextAtPoint'> {
  const { readTextAtPoint } = runtime.operations;
  const selected = readTextAtPoint ? { operations: { readTextAtPoint } } : undefined;
  return Object.freeze(
    selected
      ? {
          readTextAtPoint: async (input: ReadTextAtPointInput) =>
            await selected.operations.readTextAtPoint(input),
        }
      : {},
  );
}

/** Projects only the fact-conditional observations admitted for `wait`. */
export function selectWaitObservationOperations(
  runtime: Readonly<{
    operations: Readonly<{
      findText?: BoundNativeTextRead;
      findSelector?: BoundNativeSelectorRead;
    }>;
  }>,
): Pick<SelectorOperations, 'findText' | 'findSelector'> {
  const { findText, findSelector } = runtime.operations;
  const selectedText = findText ? { operations: { findText } } : undefined;
  const selectedSelector = findSelector ? { operations: { findSelector } } : undefined;
  return Object.freeze({
    ...(selectedText
      ? {
          findText: async (input: FindTextInput) => await selectedText.operations.findText(input),
        }
      : {}),
    ...(selectedSelector
      ? {
          findSelector: async (input: FindSelectorInput) =>
            await selectedSelector.operations.findSelector(input),
        }
      : {}),
  });
}

/** find's directly-executed mutating operations, projected from its one action-selected bind. */
export function selectFindMutatingOperations(
  runtime: Readonly<{
    operations: Readonly<{
      focusPoint?: (input: FocusPointInput) => Promise<void>;
      typeText?: (input: TypeTextInput) => Promise<TypeTextBackendResult | void>;
    }>;
  }>,
): Readonly<{
  focusPoint?: (input: FocusPointInput) => Promise<void>;
  typeText?: (input: TypeTextInput) => Promise<TypeTextBackendResult | void>;
}> {
  const { focusPoint, typeText } = runtime.operations;
  return Object.freeze({
    ...(focusPoint ? { focusPoint } : {}),
    ...(typeText ? { typeText } : {}),
  });
}
