import { expectTypeOf, test } from 'vitest';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { InteractionRuntimeInput } from '../types.ts';

test('interaction runtime accepts only explicit request capabilities', () => {
  expectTypeOf<InteractionRuntimeInput>()
    .toHaveProperty('requestId')
    .toEqualTypeOf<string | undefined>();
  expectTypeOf<InteractionRuntimeInput>()
    .toHaveProperty('flags')
    .toEqualTypeOf<CommandFlags | undefined>();
  expectTypeOf<InteractionRuntimeInput>().not.toHaveProperty('req');
  expectTypeOf<InteractionRuntimeInput>().not.toHaveProperty('command');
});
