import { expect, test } from 'vitest';
import { commandDescriptors, RAW_COMMAND_DESCRIPTORS } from '../registry.ts';

// A retired projection written in a descriptor literal fails `tsc`, but one smuggled through a
// conditional spread — the shape `ownerFiles` uses — slips past the excess-property check, and no
// `toEqual` on `platformExecution` sees a sibling key. This sweep is what actually closes it.
const RETIRED_DESCRIPTOR_KEYS = ['capability', 'dispatch'] as const;

test('no registered descriptor carries a retired capability or dispatch projection', () => {
  for (const descriptor of RAW_COMMAND_DESCRIPTORS) {
    for (const key of RETIRED_DESCRIPTOR_KEYS) {
      expect(descriptor, `${descriptor.name} raw ${key}`).not.toHaveProperty(key);
    }
  }
  for (const descriptor of commandDescriptors) {
    for (const key of RETIRED_DESCRIPTOR_KEYS) {
      expect(descriptor, `${descriptor.name} runtime ${key}`).not.toHaveProperty(key);
    }
  }
});
