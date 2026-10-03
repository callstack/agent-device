import { expect, test, vi } from 'vitest';
import {
  awaitLimrunTextEntryFocus,
  readLimrunTextEntryFocus,
  readLimrunUnambiguousTapTargets,
} from './text-entry-focus.ts';
import type { IosTreeNode } from './snapshot.ts';

type TreeRect = Readonly<{ x: number; y: number; width: number; height: number }>;

const FIELD_RECT: TreeRect = Object.freeze({ x: 24, y: 142, width: 354, height: 56 });
const ON_THE_FIELD = Object.freeze({ x: 200, y: 170 });
const OFF_THE_FIELD = Object.freeze({ x: 200, y: 810 });

const EDITING_TRAITS = Object.freeze([
  'TextEntry',
  'TextOperationsAvailable',
  'Scrollable',
  'IsEditing',
]);

function textField(
  label: string,
  options: { editing?: boolean; rect?: TreeRect | null; traits?: string[] } = {},
): IosTreeNode {
  return {
    type: 'TextField',
    AXLabel: label,
    pid: 4242,
    ...(options.rect === null ? {} : { frame: options.rect ?? FIELD_RECT }),
    traits:
      options.traits ??
      (options.editing
        ? [...EDITING_TRAITS]
        : ['TextEntry', 'TextOperationsAvailable', 'Scrollable']),
  };
}

function tree(...children: IosTreeNode[]): IosTreeNode {
  return { type: 'Application', AXLabel: 'App', children };
}

function targetsAt(point: Readonly<{ x: number; y: number }>, ...before: IosTreeNode[]) {
  return readLimrunUnambiguousTapTargets(tree(...before), point.x, point.y);
}

const noSleep = async () => {};

test('the editing element is the one carrying the provider text-entry trait', () => {
  const focused = textField('Email', { editing: true });
  const focus = readLimrunTextEntryFocus(tree(textField('Password'), focused));
  expect(focus).toEqual({ identity: expect.stringContaining('Email'), rect: FIELD_RECT });
  expect(readLimrunTextEntryFocus(tree(textField('Password')))).toBeNull();
});

test('the smallest editing element wins when a field and its container both report editing', () => {
  const container = textField('Email', {
    editing: true,
    rect: Object.freeze({ x: 0, y: 100, width: 402, height: 200 }),
  });
  const field = textField('Email', { editing: true });
  const focus = readLimrunTextEntryFocus(tree({ ...container, children: [field] }));
  expect(focus?.rect).toEqual(FIELD_RECT);
});

// An element without a frame cannot be shown to be the one we tapped.
test('an editing element with no usable frame is not offered as evidence', () => {
  expect(readLimrunTextEntryFocus(tree(textField('Email', { editing: true, rect: null })))).toBe(
    null,
  );
  expect(
    readLimrunTextEntryFocus(
      tree(textField('Email', { editing: true, rect: { x: 0, y: 0, width: 0, height: 0 } })),
    ),
  ).toBeNull();
});

test('the elements under the tapped point are the ones a fill can vouch for', () => {
  const field = textField('Email');
  const elsewhere = textField('Address', { rect: { x: 24, y: 600, width: 354, height: 56 } });
  const identity = readLimrunTextEntryFocus(
    tree({ ...field, traits: [...EDITING_TRAITS] }),
  )?.identity;
  expect(identity).toEqual(expect.any(String));
  expect(targetsAt(ON_THE_FIELD, field, elsewhere).has(identity!)).toBe(true);
  expect(targetsAt(OFF_THE_FIELD, field, elsewhere).has(identity!)).toBe(false);
});

test('re-filling the field that already holds focus is witnessed by geometry', async () => {
  const readiness = await awaitLimrunTextEntryFocus({
    targetsAtPoint: targetsAt(ON_THE_FIELD, textField('Email', { editing: true })),
    readFocus: async () => readLimrunTextEntryFocus(tree(textField('Email', { editing: true }))),
    sleep: noSleep,
    ...ON_THE_FIELD,
  });
  expect(readiness).toBe('focused-element');
});

test('a field that keeps focus while the keyboard scrolls it still counts as witnessed', async () => {
  const readiness = await awaitLimrunTextEntryFocus({
    targetsAtPoint: targetsAt(ON_THE_FIELD, textField('Email')),
    readFocus: async () =>
      readLimrunTextEntryFocus(
        tree(textField('Email', { editing: true, rect: { x: 24, y: 40, width: 354, height: 56 } })),
      ),
    sleep: noSleep,
    ...ON_THE_FIELD,
  });
  expect(readiness).toBe('focused-element');
});

test('a tap that nothing answers is refused without typing, after the budget is spent', async () => {
  const readFocus = vi.fn(async () => readLimrunTextEntryFocus(tree(textField('Email'))));
  const sleep = vi.fn(noSleep);
  await expect(
    awaitLimrunTextEntryFocus({
      targetsAtPoint: targetsAt(ON_THE_FIELD, textField('Email')),
      readFocus,
      sleep,
      ...ON_THE_FIELD,
      timeoutMs: 0,
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      reason: 'text_entry_focus_not_observed',
      x: ON_THE_FIELD.x,
      y: ON_THE_FIELD.y,
      samples: 1,
      editingElementObserved: false,
    },
  });
  expect(readFocus).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

// An editing element that was never under this point is the wrong field.
test('an editing element that was never under the tapped point is refused', async () => {
  await expect(
    awaitLimrunTextEntryFocus({
      targetsAtPoint: targetsAt(OFF_THE_FIELD, textField('Email')),
      readFocus: async () => readLimrunTextEntryFocus(tree(textField('Email', { editing: true }))),
      sleep: noSleep,
      ...OFF_THE_FIELD,
      timeoutMs: 0,
    }),
  ).rejects.toMatchObject({
    details: { reason: 'text_entry_focus_not_observed', editingElementObserved: true },
  });
});

// Fields with no identifier or label share one identity, so only geometry tells them apart.
const TWIN_A_RECT: TreeRect = Object.freeze({ x: 24, y: 142, width: 354, height: 56 });
const TWIN_B_RECT: TreeRect = Object.freeze({ x: 24, y: 262, width: 354, height: 56 });

test('a shared identity does not witness the twin that was not tapped', async () => {
  await expect(
    awaitLimrunTextEntryFocus({
      targetsAtPoint: targetsAt(
        { x: 200, y: 170 },
        textField('', { rect: TWIN_A_RECT }),
        textField('', { rect: TWIN_B_RECT }),
      ),
      readFocus: async () =>
        readLimrunTextEntryFocus(
          tree(
            textField('', { rect: TWIN_A_RECT }),
            textField('', { rect: TWIN_B_RECT, editing: true }),
          ),
        ),
      sleep: noSleep,
      x: 200,
      y: 170,
      timeoutMs: 0,
    }),
  ).rejects.toMatchObject({
    details: { reason: 'text_entry_focus_not_observed', editingElementObserved: true },
  });
});

// One unlabeled field before the tap, two after: the newcomer can share the identity of
// the field that was under the finger, so only geometry clears it.
test('a field that appears after the tap does not borrow the identity it now shares', async () => {
  await expect(
    awaitLimrunTextEntryFocus({
      targetsAtPoint: targetsAt({ x: 200, y: 170 }, textField('', { rect: TWIN_A_RECT })),
      readFocus: async () =>
        readLimrunTextEntryFocus(
          tree(
            textField('', { rect: TWIN_A_RECT }),
            textField('', { rect: TWIN_B_RECT, editing: true }),
          ),
        ),
      sleep: noSleep,
      x: 200,
      y: 170,
      timeoutMs: 0,
    }),
  ).rejects.toMatchObject({
    details: { reason: 'text_entry_focus_not_observed', editingElementObserved: true },
  });
});

test('geometry still witnesses the twin that was tapped', async () => {
  const readiness = await awaitLimrunTextEntryFocus({
    targetsAtPoint: targetsAt(
      { x: 200, y: 170 },
      textField('', { rect: TWIN_A_RECT }),
      textField('', { rect: TWIN_B_RECT }),
    ),
    readFocus: async () =>
      readLimrunTextEntryFocus(
        tree(
          textField('', { rect: TWIN_A_RECT, editing: true }),
          textField('', { rect: TWIN_B_RECT }),
        ),
      ),
    sleep: noSleep,
    x: 200,
    y: 170,
  });
  expect(readiness).toBe('focused-element');
});

test('focus that arrives late is waited for instead of typed past', async () => {
  let reads = 0;
  const readiness = await awaitLimrunTextEntryFocus({
    targetsAtPoint: targetsAt(ON_THE_FIELD, textField('Email')),
    readFocus: async () => {
      reads += 1;
      return readLimrunTextEntryFocus(
        tree(reads < 3 ? textField('Email') : textField('Email', { editing: true })),
      );
    },
    sleep: noSleep,
    ...ON_THE_FIELD,
  });
  expect(readiness).toBe('focused-element');
  expect(reads).toBe(3);
});
