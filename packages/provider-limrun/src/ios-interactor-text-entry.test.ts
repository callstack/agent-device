import { expect, test, vi } from 'vitest';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';
import type { IosTreeNode } from './snapshot.ts';

const FIELD_RECT = Object.freeze({ x: 24, y: 142, width: 354, height: 56 });

function emailField(editing: boolean): IosTreeNode {
  return {
    type: 'TextField',
    AXLabel: 'Email',
    pid: 4242,
    frame: FIELD_RECT,
    traits: editing
      ? ['TextEntry', 'TextOperationsAvailable', 'IsEditing']
      : ['TextEntry', 'TextOperationsAvailable'],
  };
}

function sessionWithTrees(trees: IosTreeNode[]) {
  const calls: string[] = [];
  let reads = 0;
  const client = {
    elementTree: vi.fn(async () => {
      calls.push('elementTree');
      const tree = trees[Math.min(reads, trees.length - 1)];
      reads += 1;
      return tree;
    }),
    tap: vi.fn(async () => {
      calls.push('tap');
    }),
    pressKey: vi.fn(async (key: string, modifiers?: string[]) => {
      calls.push(`pressKey:${key}${modifiers?.length ? `+${modifiers.join('+')}` : ''}`);
    }),
    typeText: vi.fn(async () => {
      calls.push('typeText');
    }),
  };
  const session = {
    platform: 'ios',
    instanceId: 'limrun-text-entry-instance',
    client,
  } as unknown as LimrunIosSession;
  return { interactor: createLimrunIosInteractor(session), client, calls };
}

test('type enters the focused field without the provider focus scan', async () => {
  const { interactor, client } = sessionWithTrees([]);

  await interactor.type('qa@example.com');

  expect(client.typeText).toHaveBeenCalledWith('qa@example.com', false, { requireFocus: false });
});

test('a delayed type sends one focused-blind key press per character', async () => {
  const { interactor, client } = sessionWithTrees([]);

  await interactor.type('abc', 1);

  expect(client.typeText.mock.calls).toEqual([
    ['a', false, { requireFocus: false }],
    ['b', false, { requireFocus: false }],
    ['c', false, { requireFocus: false }],
  ]);
});

test('fill waits for text-entry focus to arrive and only then sends keys', async () => {
  const { interactor, client, calls } = sessionWithTrees([
    emailField(false),
    emailField(false),
    emailField(true),
  ]);

  const result = await interactor.fill(200, 170, 'qa@example.com');

  expect(calls).toEqual([
    'elementTree',
    'tap',
    'elementTree',
    'elementTree',
    'pressKey:a+command',
    'typeText',
  ]);
  expect(result).toEqual({ textEntryReadiness: 'focused-element' });
  expect(client.typeText).toHaveBeenCalledWith('qa@example.com', false, { requireFocus: false });
});

test('fill selects the field value first, so entry replaces it', async () => {
  const { interactor, calls } = sessionWithTrees([emailField(false), emailField(true)]);

  await interactor.fill(200, 170, 'replacement');

  expect(calls.indexOf('pressKey:a+command')).toBeLessThan(calls.indexOf('typeText'));
});

test('the clear request empties the focused field instead of typing nothing', async () => {
  const { interactor, client, calls } = sessionWithTrees([emailField(false), emailField(true)]);

  const result = await interactor.fill(200, 170, '');

  expect(calls).toEqual([
    'elementTree',
    'tap',
    'elementTree',
    'pressKey:a+command',
    'pressKey:delete',
  ]);
  expect(client.typeText).not.toHaveBeenCalled();
  expect(result).toEqual({ textEntryReadiness: 'focused-element' });
});

test('a session that cannot answer the focus read fails before the device is touched', async () => {
  const { interactor, client, calls } = sessionWithTrees([emailField(false)]);
  client.elementTree.mockImplementationOnce(async () => {
    calls.push('elementTree');
    throw new Error('instance connection lost');
  });

  await expect(interactor.fill(200, 170, 'qa@example.com')).rejects.toThrow(
    'instance connection lost',
  );
  expect(calls).toEqual(['elementTree']);
  expect(client.tap).not.toHaveBeenCalled();
  expect(client.typeText).not.toHaveBeenCalled();
});
