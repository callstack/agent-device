import assert from 'node:assert/strict';
import {
  SessionScriptAggregate,
  type ScriptPublicationTarget,
  type SessionScriptState,
} from './session-script-aggregate.ts';

const OPERATION_KEY = 'close:["com.example.app"]';

type CloseCounters = {
  platform: number;
  publication: number;
};

const healedTarget = (force: boolean): ScriptPublicationTarget => ({
  path: 'checkout.healed.ad',
  source: 'healed-sibling',
  force,
});

function armRepair(force = false): SessionScriptAggregate {
  const scripts = new SessionScriptAggregate();
  scripts.replay.arm({
    sourcePath: 'checkout.ad',
    boundary: 0,
    target: healedTarget(force),
  });
  return scripts;
}

function completeCorrectedRepair(): SessionScriptAggregate {
  const scripts = armRepair(true);
  scripts.replay.stampCorrectiveResume(3);
  assert.throws(() => scripts.replay.admitCorrectiveResume(3), /no corrective action/);
  scripts.recording.record('click text="Continue anyway"');
  scripts.replay.admitCorrectiveResume(3);
  scripts.replay.complete();
  return scripts;
}

async function assertFailedCloseLeavesStateUnchanged(
  scripts: SessionScriptAggregate,
): Promise<void> {
  const before = scripts.view();
  await assert.rejects(
    () =>
      scripts.publication.finalizeExplicitClose({
        operationKey: OPERATION_KEY,
        targetPath: 'must-not-stick.ad',
        performPlatformClose: async () => {
          throw new Error('device unavailable');
        },
        publish: () => assert.fail('publication must wait for platform close'),
      }),
    /device unavailable/,
  );
  assert.deepEqual(scripts.view(), before);
}

async function failPublicationAfterClose(
  scripts: SessionScriptAggregate,
  counters: CloseCounters,
): Promise<SessionScriptState> {
  await assert.rejects(
    () =>
      scripts.publication.finalizeExplicitClose({
        operationKey: OPERATION_KEY,
        performPlatformClose: async () => {
          counters.platform += 1;
        },
        publish: () => {
          counters.publication += 1;
          throw new Error('target already exists');
        },
      }),
    /target already exists/,
  );
  const failed = scripts.view();
  assert.equal(failed.kind, 'repair');
  assert.deepEqual(failed.status, {
    kind: 'close-succeeded',
    completion: 'complete',
    receipt: { operationKey: OPERATION_KEY },
  });
  return failed;
}

async function commitOnMatchingCloseRetry(
  scripts: SessionScriptAggregate,
  counters: CloseCounters,
): Promise<SessionScriptState> {
  await scripts.publication.finalizeExplicitClose({
    operationKey: OPERATION_KEY,
    targetPath: 'checkout.promoted.ad',
    performPlatformClose: async () => {
      counters.platform += 1;
    },
    publish: (target) => {
      counters.publication += 1;
      assert.equal(target.force, false);
    },
  });
  const committed = scripts.view();
  assert.equal(committed.kind, 'repair');
  assert.equal(committed.status.kind, 'committed');
  assert.equal(counters.platform, 1);
  assert.equal(counters.publication, 2);

  await scripts.publication.finalizeExplicitClose({
    operationKey: OPERATION_KEY,
    performPlatformClose: async () => assert.fail('committed repair must not close again'),
    publish: () => assert.fail('committed repair must not publish again'),
  });
  return committed;
}

async function proveMatchingCloseRetry(): Promise<Record<string, boolean>> {
  const scripts = completeCorrectedRepair();
  await assertFailedCloseLeavesStateUnchanged(scripts);
  const counters = { platform: 0, publication: 0 };
  const failed = await failPublicationAfterClose(scripts, counters);
  assert.equal(failed.kind, 'repair');
  assert.equal(failed.sourcePath, 'checkout.ad');
  assert.equal(failed.watermark, undefined);

  const committed = await commitOnMatchingCloseRetry(scripts, counters);
  assert.equal(committed.kind, 'repair');
  assert.equal(committed.target.force, false);
  return {
    oneAggregateSpansReplayAndPublication: true,
    correctiveResumeRequiresRecordedAction: true,
    platformCloseFailureLeftStateUnchanged: true,
    failedPublishRetainedCloseReceipt: true,
    sameCloseRetrySkippedPlatformDispatch: true,
    retargetClearedPriorForce: true,
  };
}

async function proveChangedCloseIdentityRedispatches(): Promise<boolean> {
  const scripts = armRepair();
  scripts.replay.complete();
  const counters = { platform: 0, publication: 0 };
  await failPublicationAfterClose(scripts, counters);
  await scripts.publication.finalizeExplicitClose({
    operationKey: 'close:["com.example.other"]',
    performPlatformClose: async () => {
      counters.platform += 1;
    },
    publish: () => {},
  });
  assert.equal(counters.platform, 2);
  return true;
}

async function proveCommittedAndAbortedAreExplicit(): Promise<boolean> {
  const incomplete = armRepair();
  assert.equal(
    await incomplete.publication.finalizeExplicitClose({
      operationKey: 'close:[]',
      performPlatformClose: async () => {},
      publish: () => assert.fail('incomplete repair must not publish'),
    }),
    'aborted',
  );
  const incompleteState = incomplete.view();
  assert.equal(incompleteState.kind, 'repair');
  assert.equal(incompleteState.status.kind, 'aborted');

  const lifecycleAbort = armRepair();
  lifecycleAbort.publication.abortForLifecycle();
  const lifecycleState = lifecycleAbort.view();
  assert.equal(lifecycleState.kind, 'repair');
  assert.equal(lifecycleState.status.kind, 'aborted');
  return true;
}

export async function runRepairPublicationTransactionProbe(): Promise<Record<string, boolean>> {
  return {
    ...(await proveMatchingCloseRetry()),
    differentCloseIdentityRedispatched: await proveChangedCloseIdentityRedispatches(),
    committedAndAbortedAreExplicit: await proveCommittedAndAbortedAreExplicit(),
  };
}
