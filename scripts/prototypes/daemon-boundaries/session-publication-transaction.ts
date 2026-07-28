import assert from 'node:assert/strict';

type ScriptPublicationTarget = Readonly<{
  path: string;
  source: 'explicit' | 'healed-sibling';
  force: boolean;
}>;

type RepairPlatformCloseReceipt = Readonly<{
  operationKey: string;
}>;

type RepairPublicationStatus =
  | { kind: 'armed' }
  | { kind: 'complete' }
  | {
      kind: 'close-succeeded';
      completion: 'armed' | 'complete';
      receipt: RepairPlatformCloseReceipt;
    }
  | {
      kind: 'committed';
      path: string;
      receipt: RepairPlatformCloseReceipt;
    }
  | {
      kind: 'aborted';
      reason: 'explicit-close-incomplete' | 'lifecycle-incomplete';
      receipt?: RepairPlatformCloseReceipt;
    };

type RepairPublicationState = {
  sourcePath: string;
  boundary: number;
  target: ScriptPublicationTarget;
  status: RepairPublicationStatus;
};

type ExplicitCloseRequest = {
  operationKey: string;
  targetPath?: string;
  force?: boolean;
  performPlatformClose(): Promise<void>;
  publish(target: ScriptPublicationTarget): void;
};

function terminalOutcome(status: RepairPublicationStatus): 'committed' | undefined {
  if (status.kind === 'committed') return 'committed';
  assert.notEqual(status.kind, 'aborted');
  return undefined;
}

function repairCompletion(status: RepairPublicationStatus): 'armed' | 'complete' {
  if (status.kind === 'close-succeeded') return status.completion;
  assert.ok(status.kind === 'armed' || status.kind === 'complete');
  return status.kind;
}

function closeReceipt(status: RepairPublicationStatus): RepairPlatformCloseReceipt | undefined {
  return status.kind === 'close-succeeded' ? status.receipt : undefined;
}

async function settlePlatformClose(
  priorReceipt: RepairPlatformCloseReceipt | undefined,
  request: ExplicitCloseRequest,
): Promise<RepairPlatformCloseReceipt> {
  if (priorReceipt?.operationKey === request.operationKey) return priorReceipt;
  await request.performPlatformClose();
  return { operationKey: request.operationKey };
}

class RepairPublicationTransaction {
  private state: RepairPublicationState;

  constructor(sourcePath: string, target: ScriptPublicationTarget) {
    this.state = {
      sourcePath,
      boundary: 0,
      target,
      status: { kind: 'armed' },
    };
  }

  view(): RepairPublicationState {
    return structuredClone(this.state);
  }

  complete(): void {
    assert.equal(this.state.status.kind, 'armed');
    this.state.status = { kind: 'complete' };
  }

  async finalizeExplicitClose(request: ExplicitCloseRequest): Promise<'committed' | 'aborted'> {
    const terminal = terminalOutcome(this.state.status);
    if (terminal) return terminal;

    const target = retarget(this.state.target, request.targetPath, request.force);
    const priorStatus = this.state.status;
    const completion = repairCompletion(priorStatus);
    const receipt = await settlePlatformClose(closeReceipt(priorStatus), request);

    // Persist target authorization and the close receipt before publication.
    // A publication failure therefore leaves enough state for an exact retry.
    this.state.target = target;
    this.state.status = { kind: 'close-succeeded', completion, receipt };

    if (completion === 'armed') {
      this.state.status = {
        kind: 'aborted',
        reason: 'explicit-close-incomplete',
        receipt,
      };
      return 'aborted';
    }

    request.publish(target);
    this.state.status = { kind: 'committed', path: target.path, receipt };
    return 'committed';
  }

  abortForLifecycle(): void {
    assert.equal(this.state.status.kind, 'armed');
    this.state.status = { kind: 'aborted', reason: 'lifecycle-incomplete' };
  }
}

function retarget(
  current: ScriptPublicationTarget,
  requestedPath: string | undefined,
  liveForce: boolean | undefined,
): ScriptPublicationTarget {
  if (!requestedPath || requestedPath === current.path) {
    return { ...current, force: current.force || liveForce === true };
  }
  return {
    path: requestedPath,
    source: 'explicit',
    force: liveForce === true,
  };
}

export async function runRepairPublicationTransactionProbe(): Promise<Record<string, boolean>> {
  const transaction = new RepairPublicationTransaction('checkout.ad', {
    path: 'checkout.healed.ad',
    source: 'healed-sibling',
    force: true,
  });
  transaction.complete();

  const beforeFailedClose = transaction.view();
  await assert.rejects(
    () =>
      transaction.finalizeExplicitClose({
        operationKey: 'close:["com.example.app"]',
        performPlatformClose: async () => {
          throw new Error('device unavailable');
        },
        publish: () => assert.fail('publication must wait for platform close'),
      }),
    /device unavailable/,
  );
  const afterFailedClose = transaction.view();
  assert.deepEqual(afterFailedClose, beforeFailedClose);

  let platformCloseCalls = 0;
  let publicationCalls = 0;
  const operationKey = 'close:["com.example.app"]';
  await assert.rejects(
    () =>
      transaction.finalizeExplicitClose({
        operationKey,
        performPlatformClose: async () => {
          platformCloseCalls += 1;
        },
        publish: () => {
          publicationCalls += 1;
          throw new Error('target already exists');
        },
      }),
    /target already exists/,
  );
  const failedPublication = transaction.view();
  assert.deepEqual(failedPublication.status, {
    kind: 'close-succeeded',
    completion: 'complete',
    receipt: { operationKey },
  });

  await transaction.finalizeExplicitClose({
    operationKey,
    targetPath: 'checkout.promoted.ad',
    performPlatformClose: async () => {
      platformCloseCalls += 1;
    },
    publish: (target) => {
      publicationCalls += 1;
      assert.equal(target.force, false);
    },
  });
  const committed = transaction.view();
  assert.equal(committed.status.kind, 'committed');
  assert.equal(platformCloseCalls, 1);
  assert.equal(publicationCalls, 2);
  const sameCloseRetrySkippedPlatformDispatch = platformCloseCalls === 1;

  await transaction.finalizeExplicitClose({
    operationKey,
    performPlatformClose: async () => assert.fail('committed repair must not close again'),
    publish: () => assert.fail('committed repair must not publish again'),
  });

  const changedClose = new RepairPublicationTransaction('checkout.ad', {
    path: 'checkout.healed.ad',
    source: 'healed-sibling',
    force: false,
  });
  changedClose.complete();
  let changedCloseCalls = 0;
  await assert.rejects(
    () =>
      changedClose.finalizeExplicitClose({
        operationKey,
        performPlatformClose: async () => {
          changedCloseCalls += 1;
        },
        publish: () => {
          throw new Error('target already exists');
        },
      }),
    /target already exists/,
  );
  await changedClose.finalizeExplicitClose({
    operationKey: 'close:["com.example.other"]',
    performPlatformClose: async () => {
      changedCloseCalls += 1;
    },
    publish: () => {},
  });
  assert.equal(changedCloseCalls, 2);

  const incomplete = new RepairPublicationTransaction('checkout.ad', {
    path: 'checkout.healed.ad',
    source: 'healed-sibling',
    force: false,
  });
  assert.equal(
    await incomplete.finalizeExplicitClose({
      operationKey: 'close:[]',
      performPlatformClose: async () => {},
      publish: () => assert.fail('incomplete repair must not publish'),
    }),
    'aborted',
  );
  const lifecycleAbort = new RepairPublicationTransaction('checkout.ad', {
    path: 'checkout.healed.ad',
    source: 'healed-sibling',
    force: false,
  });
  lifecycleAbort.abortForLifecycle();

  return {
    platformCloseFailureLeftStateUnchanged:
      JSON.stringify(beforeFailedClose) === JSON.stringify(afterFailedClose),
    failedPublishRetainedCloseReceipt: failedPublication.status.kind === 'close-succeeded',
    sameCloseRetrySkippedPlatformDispatch,
    retargetClearedPriorForce: committed.target.force === false,
    differentCloseIdentityRedispatched: changedCloseCalls === 2,
    committedAndAbortedAreExplicit:
      committed.status.kind === 'committed' &&
      incomplete.view().status.kind === 'aborted' &&
      lifecycleAbort.view().status.kind === 'aborted',
  };
}
