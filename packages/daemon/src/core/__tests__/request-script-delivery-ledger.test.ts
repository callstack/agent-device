import { expect, test } from 'vitest';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import { readScriptDeliveryReceipt } from '@agent-device/kernel/contracts';
import type { DaemonRequest } from '../daemon-request.ts';
import {
  collectBatchStepDelivery,
  type ScriptDeliveryLedger,
  reportScriptDelivery,
} from '../request-script-delivery-ledger.ts';

/**
 * The batch delivery receipt's daemon owner (ADR 0016, #4595). Each case answers step replies the
 * way a batch runner reports them and asserts what the ONE outer receipt says, because a client may
 * act only on that receipt.
 */

const ID = '3f2a1b0c-0000-4000-8000-000000000001';
const OTHER = '9a8b7c6d-0000-4000-8000-000000000002';

/** The batch request an outermost client sends: its ledger is the one the request owner creates. */
function batchRequest(steps: number): DaemonRequest {
  return {
    token: 't',
    session: 'journey',
    command: 'batch',
    positionals: [],
    flags: { batchSteps: Array.from({ length: steps }, () => ({ command: 'wait' })) },
  };
}

/** The ledger the request owner created for `outer`, as the batch runner sees it. */
function ledgerOf(outer: DaemonRequest): ScriptDeliveryLedger {
  const scriptDelivery = outer.internal?.scriptDelivery;
  if (!scriptDelivery) throw new Error('the request owner answers its handlers on a ledger');
  return scriptDelivery;
}

function script(artifactId: string, revision: number, publicationId = ID): DaemonArtifact {
  return {
    field: 'savedScript',
    artifactType: 'session-script',
    artifactId,
    scriptPublicationId: publicationId,
    scriptRevision: revision,
  };
}

function failure(publicationId = ID) {
  return {
    reason: 'script_delivery_failed' as const,
    publicationId,
    message: 'The action succeeded, but the daemon could not write the remote recording.',
    hint: 'The next recorded action delivers the full recording again.',
  };
}

test('a request whose steps delivered nothing answers no receipt', async () => {
  const response = await reportScriptDelivery(batchRequest(1), async () => ({
    ok: true,
    data: { results: [] },
  }));

  expect(response).toEqual({ ok: true, data: { results: [] } });
});

test('a reply no nested step fed answers no receipt, even when it names script artifacts', async () => {
  // A single command's own reply already delivers through its artifacts; a receipt on it would
  // change every recorded action's shape. Only a request whose ledger its nested steps fed — a
  // composite — answers one.
  const response = await reportScriptDelivery(batchRequest(1), async () => ({
    ok: true,
    data: { artifacts: [script('v2', 2)], scriptDeliveryFailure: failure() },
  }));

  expect(response).toEqual({
    ok: true,
    data: { artifacts: [script('v2', 2)], scriptDeliveryFailure: failure() },
  });
});

test('the versions, the failure and the close the steps answered become one receipt on the outer reply', async () => {
  let scriptDelivery: ScriptDeliveryLedger | undefined;
  const response = await reportScriptDelivery(batchRequest(2), async (outer) => {
    scriptDelivery = ledgerOf(outer);
    collectBatchStepDelivery(
      outer,
      { number: 1, command: 'wait' },
      {
        ok: true,
        data: { artifacts: [script('v2', 2)] },
      },
    );
    collectBatchStepDelivery(
      outer,
      { number: 2, command: ' CLOSE ' },
      {
        ok: true,
        data: {
          scriptPublicationId: ID,
          artifacts: [script('v3', 3)],
          scriptDeliveryFailure: failure(),
        },
      },
    );
    return { ok: true, data: { results: [{ ok: true }, { ok: true }] } };
  });

  expect(response).toMatchObject({
    ok: true,
    data: {
      scriptDeliveryReceipt: {
        publicationId: ID,
        version: { artifactId: 'v3', scriptRevision: 3 },
        close: { step: 2 },
        failures: [{ message: failure().message }],
      },
    },
  });
  expect(scriptDelivery?.nested).toBe(true);
});

test('a failed batch answers the receipt in the error details and keeps the original error', async () => {
  const original: DaemonResponse = {
    ok: false,
    error: { code: 'COMMAND_FAILED', message: 'step 2 failed' },
  };

  const response = await reportScriptDelivery(batchRequest(2), async (outer) => {
    collectBatchStepDelivery(
      outer,
      { number: 1, command: 'wait' },
      {
        ok: true,
        data: { artifacts: [script('v2', 2)] },
      },
    );
    collectBatchStepDelivery(outer, { number: 2, command: 'tap' }, original);
    return original;
  });

  if (!response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    expect(response.error.message).toBe('step 2 failed');
    expect(response.error.details).toMatchObject({
      scriptDeliveryReceipt: { publicationId: ID, version: { artifactId: 'v2' } },
    });
  } else {
    throw new Error('a failed batch keeps failing');
  }
});

test('a step that failed contributes no version, no close, and no failure', async () => {
  let scriptDelivery: ScriptDeliveryLedger | undefined;
  await reportScriptDelivery(batchRequest(1), async (outer) => {
    scriptDelivery = ledgerOf(outer);
    collectBatchStepDelivery(
      outer,
      { number: 1, command: 'close' },
      {
        ok: false,
        error: { code: 'COMMAND_FAILED', message: 'close failed' },
      },
    );
    return { ok: false, error: { code: 'COMMAND_FAILED', message: 'close failed' } };
  });

  expect(scriptDelivery?.versions.size).toBe(0);
  expect(scriptDelivery?.close).toBeUndefined();
  expect(scriptDelivery?.failures.size).toBe(0);
});

test('a close names the recording only for the plan position that ran close', async () => {
  let scriptDelivery: ScriptDeliveryLedger | undefined;

  await reportScriptDelivery(batchRequest(2), async (outer) => {
    scriptDelivery = ledgerOf(outer);
    // Only a `close` step's reply means a close; another command naming the ID means a version.
    collectBatchStepDelivery(
      outer,
      { number: 1, command: 'save-script' },
      {
        ok: true,
        data: { scriptPublicationId: ID },
      },
    );
    return { ok: true, data: {} };
  });

  expect(scriptDelivery?.close).toBeUndefined();
});

test('a close whose final write failed names both the close and the failure', async () => {
  const response = await reportScriptDelivery(batchRequest(1), async (outer) => {
    collectBatchStepDelivery(
      outer,
      { number: 1, command: 'close' },
      {
        ok: true,
        data: { scriptPublicationId: ID, scriptDeliveryFailure: failure() },
      },
    );
    return { ok: true, data: {} };
  });

  expect(response).toMatchObject({
    ok: true,
    data: {
      scriptDeliveryReceipt: {
        publicationId: ID,
        close: { step: 1 },
        failures: [{ message: failure().message }],
      },
    },
  });
});

test('a non-object artifact entry never hides a valid version', async () => {
  const response = await reportScriptDelivery(batchRequest(1), async (outer) => {
    collectBatchStepDelivery(
      outer,
      { number: 1, command: 'wait' },
      {
        ok: true,
        data: {
          artifacts: [
            null,
            42,
            'script',
            undefined,
            script('v7', 7),
          ] as unknown as DaemonArtifact[],
        },
      },
    );
    return { ok: true, data: {} };
  });

  expect(response).toMatchObject({
    ok: true,
    data: { scriptDeliveryReceipt: { version: { artifactId: 'v7', scriptRevision: 7 } } },
  });
});

test('a higher entry of another type never masks this recording’s version', async () => {
  const response = await reportScriptDelivery(batchRequest(1), async (outer) => {
    collectBatchStepDelivery(
      outer,
      { number: 1, command: 'wait' },
      {
        ok: true,
        data: {
          artifacts: [{ ...script('shot', 99), artifactType: 'screenshot' }, script('mine', 4)],
        },
      },
    );
    return { ok: true, data: {} };
  });

  expect(response).toMatchObject({
    ok: true,
    data: { scriptDeliveryReceipt: { publicationId: ID, version: { artifactId: 'mine' } } },
  });
});

test('a version of another recording answers no receipt rather than guessing one', async () => {
  // One reply delivers one recording. Facts for two of them are an anomaly, so nothing is delivered.
  const response = await reportScriptDelivery(batchRequest(1), async (outer) => {
    collectBatchStepDelivery(
      outer,
      { number: 1, command: 'wait' },
      {
        ok: true,
        data: { artifacts: [script('other', 99, OTHER), script('mine', 4)] },
      },
    );
    return { ok: true, data: {} };
  });

  expect(response).toEqual({ ok: true, data: {} });
});

test('a version on the batch reply itself is delivered even when no step carries one', async () => {
  const response = await reportScriptDelivery(batchRequest(1), async (outer) => {
    collectBatchStepDelivery(outer, { number: 1, command: 'wait' }, { ok: true, data: {} });
    return { ok: true, data: { artifacts: [script('outer', 3)] } };
  });

  expect(response).toMatchObject({
    ok: true,
    data: { scriptDeliveryReceipt: { version: { artifactId: 'outer', scriptRevision: 3 } } },
  });
});

test('the newest version wins among the entries many steps carried', async () => {
  const response = await reportScriptDelivery(batchRequest(3), async (outer) => {
    for (const [number, revision] of [
      [1, 5],
      [2, 6],
      [3, 4],
    ] as const) {
      collectBatchStepDelivery(
        outer,
        { number, command: 'wait' },
        {
          ok: true,
          data: { artifacts: [script(`v${revision}`, revision)] },
        },
      );
    }
    return { ok: true, data: {} };
  });

  expect(response).toMatchObject({
    ok: true,
    data: { scriptDeliveryReceipt: { version: { artifactId: 'v6', scriptRevision: 6 } } },
  });
});

test('facts collected for two recordings answer no receipt rather than guessing one', async () => {
  const response = await reportScriptDelivery(batchRequest(2), async (outer) => {
    collectBatchStepDelivery(
      outer,
      { number: 1, command: 'wait' },
      {
        ok: true,
        data: { artifacts: [script('mine', 2)] },
      },
    );
    collectBatchStepDelivery(
      outer,
      { number: 2, command: 'wait' },
      {
        ok: true,
        data: { artifacts: [script('theirs', 2, OTHER)] },
      },
    );
    return { ok: true, data: {} };
  });

  expect(response).toEqual({ ok: true, data: {} });
});

test('a nested request keeps its delegating ledger and answers no receipt of its own', async () => {
  const scriptDelivery: ScriptDeliveryLedger = {
    nested: false,
    versions: new Map(),
    failures: new Map(),
  };
  const nestedRequest: DaemonRequest = {
    ...batchRequest(1),
    command: 'wait',
    internal: { scriptDelivery },
  };

  const nested = await reportScriptDelivery(nestedRequest, async (inner) => {
    collectBatchStepDelivery(
      inner,
      { number: 1, command: 'wait' },
      {
        ok: true,
        data: { artifacts: [script('v2', 2)] },
      },
    );
    return { ok: true, data: {} };
  });

  expect(nested).toEqual({ ok: true, data: {} });
  expect(scriptDelivery.versions.get(ID)?.scriptRevision).toBe(2);
});

test('all failures in a maximum-sized batch leave its close receipt readable', async () => {
  const response = await reportScriptDelivery(batchRequest(1000), async (outer) => {
    for (let number = 1; number <= 1000; number++) {
      collectBatchStepDelivery(
        outer,
        { number, command: number === 1000 ? 'close' : 'wait' },
        {
          ok: true,
          data: { scriptPublicationId: ID, scriptDeliveryFailure: failure() },
        },
      );
    }
    return { ok: true, data: {} };
  });
  const receipt = readScriptDeliveryReceipt(response);
  expect(receipt?.failures).toHaveLength(1000);
  expect(receipt?.close).toEqual({ step: 1000 });
});
