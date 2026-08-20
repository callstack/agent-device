import type {
  ElementTextRuntimeOperations,
  FindSelectorInput,
  FindSelectorRuntimeOperations,
  FindTextInput,
  FindTextRuntimeOperations,
  ReadTextAtPointInput,
} from '@agent-device/contracts/platform';

export type BoundElementRead = ElementTextRuntimeOperations['readTextAtPoint'];
export type BoundNativeTextRead = FindTextRuntimeOperations['findText'];
export type BoundNativeSelectorRead = FindSelectorRuntimeOperations['findSelector'];

type SelectorOperations = Readonly<{
  readTextAtPoint?: BoundElementRead;
  findText?: BoundNativeTextRead;
  findSelector?: BoundNativeSelectorRead;
}>;

/** Projects only admitted selector operations and captures each narrowed function exactly once. */
export function selectSelectorOperations(
  runtime: Readonly<{ operations: SelectorOperations }>,
): SelectorOperations {
  const { readTextAtPoint, findText, findSelector } = runtime.operations;
  return Object.freeze({
    ...(readTextAtPoint
      ? {
          readTextAtPoint: bindElementRead({ operations: { readTextAtPoint } }),
        }
      : {}),
    ...(findText ? { findText: bindConditionalTextRead({ operations: { findText } }) } : {}),
    ...(findSelector
      ? {
          findSelector: bindConditionalSelectorRead({ operations: { findSelector } }),
        }
      : {}),
  });
}

function bindElementRead(
  runtime: Readonly<{ operations: Readonly<{ readTextAtPoint: BoundElementRead }> }>,
): BoundElementRead {
  return async (input: ReadTextAtPointInput) => await runtime.operations.readTextAtPoint(input);
}

function bindConditionalTextRead(
  runtime: Readonly<{ operations: Readonly<{ findText: BoundNativeTextRead }> }>,
): BoundNativeTextRead {
  return async (input: FindTextInput) => await runtime.operations.findText(input);
}

function bindConditionalSelectorRead(
  runtime: Readonly<{ operations: Readonly<{ findSelector: BoundNativeSelectorRead }> }>,
): BoundNativeSelectorRead {
  return async (input: FindSelectorInput) => await runtime.operations.findSelector(input);
}
