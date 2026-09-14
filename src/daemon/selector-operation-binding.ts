import type { TypeTextBackendResult } from '@agent-device/contracts/interactor-types';
import type {
  ElementTextRuntimeOperations,
  ReadTextAtPointInput,
} from '@agent-device/contracts/element-text-runtime';
import type { FocusPointInput } from '@agent-device/contracts/focus-runtime';
import type { TypeTextInput } from '@agent-device/contracts/type-text-runtime';
import type {
  FindTextInput,
  FindTextRuntimeOperations,
} from '@agent-device/contracts/selector-observation-runtime';

export type BoundElementRead = ElementTextRuntimeOperations['readTextAtPoint'];
export type BoundNativeTextRead = FindTextRuntimeOperations['findText'];

type SelectorOperations = Readonly<{
  readTextAtPoint?: BoundElementRead;
  findText?: BoundNativeTextRead;
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

/** Native observation failures defer to canonical capture; cancellation remains terminal. */
export function selectWaitObservationOperations(
  runtime: Readonly<{
    operations: Readonly<{
      findText?: BoundNativeTextRead;
    }>;
  }>,
): Pick<SelectorOperations, 'findText'> {
  const { findText } = runtime.operations;
  return Object.freeze(
    findText
      ? {
          findText: async (input: FindTextInput) => {
            input.signal?.throwIfAborted();
            try {
              const result = await findText(input);
              input.signal?.throwIfAborted();
              return result;
            } catch {
              input.signal?.throwIfAborted();
              return { found: false };
            }
          },
        }
      : {},
  );
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
