import { INTERNAL_COMMAND_DESCRIPTORS } from '../internal.ts';
import { expect, test } from 'vitest';

// the daemon-owned control plane: the command names it declares are pinned as literals, so a descriptor that
// leaves this family file — or a second copy of one — lands in this diff instead of being
// noticed only through a derived view.
test('internal declares exactly its own commands', () => {
  expect(INTERNAL_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name).sort()).toEqual([
    'human_control',
    'install_source',
    'lease_allocate',
    'lease_heartbeat',
    'lease_release',
    'release_materialized_paths',
    'runtime',
    'session_list',
    'session_save_script',
  ]);
});
