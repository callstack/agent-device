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

type PreferredSelectorOperations = Readonly<{
  readTextAtPoint?: BoundElementRead;
  findText?: BoundNativeTextRead;
  findSelector?: BoundNativeSelectorRead;
}>;

/** Projects only admitted preferred operations and captures each narrowed function exactly once. */
export function selectPreferredSelectorOperations(
  runtime: Readonly<{ operations: PreferredSelectorOperations }>,
): PreferredSelectorOperations {
  const { readTextAtPoint, findText, findSelector } = runtime.operations;
  return Object.freeze({
    ...(readTextAtPoint
      ? {
          readTextAtPoint: bindPreferredElementRead({ operations: { readTextAtPoint } }),
        }
      : {}),
    ...(findText ? { findText: bindPreferredTextRead({ operations: { findText } }) } : {}),
    ...(findSelector
      ? {
          findSelector: bindPreferredSelectorRead({ operations: { findSelector } }),
        }
      : {}),
  });
}

function bindPreferredElementRead(
  runtime: Readonly<{ operations: Readonly<{ readTextAtPoint: BoundElementRead }> }>,
): BoundElementRead {
  return async (input: ReadTextAtPointInput) => await runtime.operations.readTextAtPoint(input);
}

function bindPreferredTextRead(
  runtime: Readonly<{ operations: Readonly<{ findText: BoundNativeTextRead }> }>,
): BoundNativeTextRead {
  return async (input: FindTextInput) => await runtime.operations.findText(input);
}

function bindPreferredSelectorRead(
  runtime: Readonly<{ operations: Readonly<{ findSelector: BoundNativeSelectorRead }> }>,
): BoundNativeSelectorRead {
  return async (input: FindSelectorInput) => await runtime.operations.findSelector(input);
}
