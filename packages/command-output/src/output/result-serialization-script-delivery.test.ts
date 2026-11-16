import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ScriptDeliveryFailure } from '@agent-device/kernel/contracts';
import {
  serializeCloseResult,
  serializeOpenResult,
  serializeSnapshotResult,
} from './result-serialization.ts';

/**
 * A remote recording's script version that did not reach the caller file keeps its action
 * successful, so machine output is where a caller learns the file is stale (ADR 0016, #4564). Every
 * family that can report a script version emits the two fields through one helper; this table pins
 * each of them, so a serializer that stops carrying either field fails here.
 */

const WARNING = 'The session recorded version 2, but the daemon could not save it.';

const FAILURE: ScriptDeliveryFailure = {
  reason: 'script_delivery_failed',
  cause: 'script_write_failed',
  publicationId: '0f61b0c2-6d1a-4d1f-9b7f-2a4f3a1c7d55',
  message: WARNING,
  hint: 'The file keeps the version from the last action that arrived.',
};

const DISCLOSURE = { warnings: [WARNING], scriptDeliveryFailure: FAILURE };

/** The machine output of each family whose result can carry a script version. */
const outputs: Array<{
  label: string;
  /** Called with the disclosure fields, and with PLAIN input that names none of them. */
  serialize: (input?: Record<string, unknown>) => Record<string, unknown>;
}> = [
  {
    label: 'open',
    serialize: (input) => serializeOpenResult({ session: 'qa', ...input } as never),
  },
  {
    label: 'session close',
    serialize: (input) =>
      serializeCloseResult({ session: 'qa', savedScript: '/tmp/journey.ad', ...input } as never),
  },
  {
    label: 'snapshot',
    serialize: (input) => serializeSnapshotResult({ nodes: [], ...input } as never),
  },
];

for (const output of outputs) {
  test(`the ${output.label} machine output carries a failed script delivery`, () => {
    const data = output.serialize(DISCLOSURE);

    assert.deepEqual(data.scriptDeliveryFailure, FAILURE);
    assert.deepEqual(data.warnings, [WARNING]);
  });

  test(`the ${output.label} machine output omits a disclosure it was not given`, () => {
    // PLAIN input: nothing here names a script, so a serializer that invents either field fails.
    const data = output.serialize();

    assert.equal('scriptDeliveryFailure' in data, false);
    assert.equal('warnings' in data, false);
  });

  test(`the ${output.label} machine output keeps the failure beside an empty warning list`, () => {
    const empty = output.serialize({ ...DISCLOSURE, warnings: [] });

    assert.deepEqual(empty.scriptDeliveryFailure, FAILURE);
    assert.equal('warnings' in empty, false);
  });
}
