import { REPLAY_COMMAND_DESCRIPTORS } from '../replay.ts';
import { expect, test } from 'vitest';

// the commands that run other commands: the command names it declares are pinned as literals, so a descriptor that
// leaves this family file — or a second copy of one — lands in this diff instead of being
// noticed only through a derived view.
test('replay declares exactly its own commands', () => {
  expect(REPLAY_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name).sort()).toEqual([
    'batch',
    'replay',
    'test',
  ]);
});
