import { OBSERVABILITY_COMMAND_DESCRIPTORS } from '../observability.ts';
import { expect, test } from 'vitest';

// The command names this family file declares, pinned as literals. A descriptor that leaves
// this file, or a second copy of one, has to change this list in the same diff instead of
// surfacing only through a derived view.
test('observability declares exactly its own commands', () => {
  expect(OBSERVABILITY_COMMAND_DESCRIPTORS.map((descriptor) => descriptor.name).sort()).toEqual([
    'audio',
    'events',
    'logs',
    'network',
    'perf',
  ]);
});
