import { MANAGEMENT_COMMAND_DESCRIPTORS } from '../management.ts';
import { expect, test } from 'vitest';

// The command names this family file declares, pinned as literals. A descriptor that leaves
// this file, or a second copy of one, has to change this list in the same diff instead of
// surfacing only through a derived view.
test('management declares exactly its own commands', () => {
  expect(MANAGEMENT_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name).sort()).toEqual([
    'apps',
    'artifacts',
    'boot',
    'capabilities',
    'close',
    'devices',
    'doctor',
    'install',
    'install-from-source',
    'open',
    'prepare',
    'push',
    'reinstall',
    'shutdown',
    'trigger-app-event',
    'viewport',
  ]);
});
