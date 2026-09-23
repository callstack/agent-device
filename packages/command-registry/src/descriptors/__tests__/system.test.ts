import { SYSTEM_COMMAND_DESCRIPTORS } from '../system.ts';
import { expect, test } from 'vitest';

// The command names this family file declares, pinned as literals. A descriptor that leaves
// this file, or a second copy of one, has to change this list in the same diff instead of
// surfacing only through a derived view.
test('system declares exactly its own commands', () => {
  expect(SYSTEM_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name).sort()).toEqual([
    'action-button',
    'app-switcher',
    'appstate',
    'back',
    'clipboard',
    'fold',
    'home',
    'keyboard',
    'orientation',
    'tv-remote',
  ]);
});
