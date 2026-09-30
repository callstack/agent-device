import assert from 'node:assert/strict';
import { test } from 'vitest';
import { RUNTIME_OPERATION_NAMES } from '@agent-device/contracts/runtime-operation-names';
import { RUNTIME_OPERATION_EFFECTS } from '../runtime-operation-effects.ts';

// The table's `Record` type refuses a missing or unknown operation at compile time; this is the
// same rule at run time, so an operation without a declared effect cannot bind unrecorded.
test('every runtime operation declares its effect, and only runtime operations do', () => {
  assert.deepEqual(
    Object.keys(RUNTIME_OPERATION_EFFECTS).sort(),
    [...RUNTIME_OPERATION_NAMES].sort(),
  );
  for (const effect of Object.values(RUNTIME_OPERATION_EFFECTS)) {
    assert.ok(effect === 'mutates' || effect === 'repeatable', effect);
  }
});
