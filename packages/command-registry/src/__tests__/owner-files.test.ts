import { describe, expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';
import { COMMAND_OWNER_FILES, ownerFilesForCommand } from '../owner-files.ts';

describe('command owner-file projection', () => {
  test('covers exactly the registered commands (completeness, no extras)', () => {
    const declared = Object.keys(COMMAND_OWNER_FILES).sort();
    const registered = commandDescriptors.map((descriptor) => descriptor.name).sort();
    expect(declared).toEqual(registered);
  });

  test('every command maps to a non-empty owner-file list', () => {
    for (const descriptor of commandDescriptors) {
      expect(ownerFilesForCommand(descriptor.name).length).toBeGreaterThan(0);
    }
  });

  test('the projection is not reachable from the runtime descriptor objects', () => {
    for (const descriptor of commandDescriptors) {
      expect(Object.hasOwn(descriptor, 'ownerFiles')).toBe(false);
    }
  });
});
