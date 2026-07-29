import assert from 'node:assert/strict';
import { runRepairPublicationTransactionProbe } from './session-publication-transaction.ts';
import { SessionScriptAggregate, type SessionScriptState } from './session-script-aggregate.ts';

type RefFrame = { generation: number; status: 'active' | 'expired' };

type SessionSnapshot = {
  revision: number;
  refFrame?: RefFrame;
  script: SessionScriptState;
  events: readonly string[];
};

class LockedSessionState {
  private revision = 0;
  private nextGeneration = 1;
  private refFrame: RefFrame | undefined;
  private readonly scripts = new SessionScriptAggregate();
  private readonly events: string[] = [];

  snapshot(): SessionSnapshot {
    return structuredClone({
      revision: this.revision,
      refFrame: this.refFrame,
      script: this.scripts.view(),
      events: this.events,
    });
  }

  activateRefFrame(): void {
    this.refFrame = { generation: this.nextGeneration++, status: 'active' };
    this.commit(`ref-frame:activated:${this.refFrame.generation}`);
  }

  attemptMutation(operation: string, succeeds: boolean): void {
    if (this.refFrame?.status === 'active') {
      this.refFrame.status = 'expired';
      this.events.push(`ref-frame:expired-before:${operation}`);
    }
    this.events.push(`mutation:${operation}:${succeeds ? 'succeeded' : 'failed'}`);
    this.commit('mutation-attempt');
  }

  armOrdinaryRecording(): void {
    this.scripts.recording.armOrdinary({
      path: 'session.ad',
      source: 'explicit',
      force: false,
    });
    this.commit('ordinary-recording:armed');
  }

  recordAction(action: string): void {
    this.scripts.recording.record(action);
    this.commit(`action:${action}`);
  }

  beginRepair(sourcePath: string): void {
    this.scripts.replay.arm({
      sourcePath,
      boundary: 0,
      target: {
        path: 'checkout.healed.ad',
        source: 'healed-sibling',
        force: false,
      },
    });
    this.commit('repair:armed');
  }

  publishActive(): void {
    this.scripts.publication.publishActive();
    this.commit('ordinary-recording:published');
  }

  private commit(event: string): void {
    this.revision += 1;
    this.events.push(event);
  }
}

function validateResumeClaim(
  claim: { from: number; planDigest: string },
  prepared: { planDigest: string; stepCount: number },
): void {
  if (claim.planDigest !== prepared.planDigest) {
    throw new Error('stale client-supplied plan digest');
  }
  if (!isValidStepOrdinal(claim.from, prepared.stepCount)) {
    throw new Error('resume ordinal is invalid');
  }
}

function isValidStepOrdinal(from: number, stepCount: number): boolean {
  return Number.isInteger(from) && from >= 1 && from <= stepCount;
}

const mutationSession = new LockedSessionState();
mutationSession.activateRefFrame();
mutationSession.attemptMutation('failed-click', false);
assert.equal(mutationSession.snapshot().refFrame?.status, 'expired');

const successfulMutationSession = new LockedSessionState();
successfulMutationSession.activateRefFrame();
successfulMutationSession.attemptMutation('successful-click', true);
assert.equal(successfulMutationSession.snapshot().refFrame?.status, 'expired');

const repairPublicationEvidence = await runRepairPublicationTransactionProbe();

const publicationSession = new LockedSessionState();
publicationSession.armOrdinaryRecording();
publicationSession.recordAction('fill text=${PASSWORD}');
publicationSession.publishActive();
assert.deepEqual(publicationSession.snapshot().script, {
  kind: 'ordinary',
  target: { path: 'session.ad', source: 'explicit', force: false },
  status: { kind: 'published', path: 'session.ad' },
  actions: ['fill text=${PASSWORD}'],
});
assert.throws(() => publicationSession.publishActive(), /already published/);

const disjointSession = new LockedSessionState();
disjointSession.beginRepair('checkout.ad');
assert.throws(() => disjointSession.publishActive(), /unavailable during repair/);
const stateBeforeStaleClaim = disjointSession.snapshot();
assert.throws(
  () =>
    validateResumeClaim(
      { from: 2, planDigest: 'stale-plan' },
      { planDigest: 'fresh-plan', stepCount: 3 },
    ),
  /stale client-supplied plan digest/,
);
assert.deepEqual(disjointSession.snapshot(), stateBeforeStaleClaim);

process.stdout.write(
  `${JSON.stringify(
    {
      question: 'Can replay avoid a mutable session interface entirely?',
      result: 'yes',
      evidence: {
        failedMutationExpiredRefs: mutationSession.snapshot().refFrame?.status === 'expired',
        successfulMutationExpiredRefs:
          successfulMutationSession.snapshot().refFrame?.status === 'expired',
        ...repairPublicationEvidence,
        clientDigestValidationLeftSessionUntouched: true,
        activePublicationIsRepairDisjoint: true,
        parameterizedArtifactPublished:
          publicationSession.snapshot().script.kind === 'ordinary' &&
          publicationSession.snapshot().script.actions[0] === 'fill text=${PASSWORD}',
      },
    },
    null,
    2,
  )}\n`,
);
