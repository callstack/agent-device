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
  QuerySelectorRuntimeOperations,
} from '@agent-device/contracts/selector-observation-runtime';

export type BoundElementRead = ElementTextRuntimeOperations['readTextAtPoint'];
export type BoundNativeTextRead = FindTextRuntimeOperations['findText'];
export type BoundSelectorQuery = QuerySelectorRuntimeOperations['querySelector'];

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

/**
 * find's directly-executed mutating operations, projected from its one action-selected bind, plus the
 * owner's conditional live selector read when it advertised one (the #1542 off-screen rescue).
 */
export function selectFindMutatingOperations(
  runtime: Readonly<{
    operations: Readonly<{
      focusPoint?: (input: FocusPointInput) => Promise<void>;
      typeText?: (input: TypeTextInput) => Promise<TypeTextBackendResult | void>;
      querySelector?: BoundSelectorQuery;
    }>;
  }>,
): Readonly<{
  focusPoint?: (input: FocusPointInput) => Promise<void>;
  typeText?: (input: TypeTextInput) => Promise<TypeTextBackendResult | void>;
  querySelector?: BoundSelectorQuery;
}> {
  const { focusPoint, typeText, querySelector } = runtime.operations;
  return Object.freeze({
    ...(focusPoint ? { focusPoint } : {}),
    ...(typeText ? { typeText } : {}),
    ...(querySelector ? { querySelector } : {}),
  });
}
