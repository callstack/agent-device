import assert from 'node:assert/strict';
import { runRepairPublicationTransactionProbe } from './session-publication-transaction.ts';

type RefFrame = { generation: number; status: 'active' | 'expired' };
type RepairTransaction = {
  sourcePath: string;
  phase: 'armed' | 'complete';
  acceptedSteps: number[];
  pendingResume?: {
    expectedFrom: number;
    actionsCountAtDivergence: number;
  };
};

type SessionScriptState =
  | { kind: 'idle' }
  | {
      kind: 'ordinary';
      phase: 'armed' | 'recording' | 'published';
      actions: string[];
    }
  | {
      kind: 'repair';
      transaction: RepairTransaction;
      actions: string[];
    };

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
  private script: SessionScriptState = { kind: 'idle' };
  private readonly events: string[] = [];

  snapshot(): SessionSnapshot {
    return structuredClone({
      revision: this.revision,
      refFrame: this.refFrame,
      script: this.script,
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
    this.assert(this.script.kind !== 'repair', 'ordinary recording is unavailable during repair');
    this.assert(this.script.kind === 'idle', 'ordinary recording is already active');
    this.script = { kind: 'ordinary', phase: 'armed', actions: [] };
    this.commit('ordinary-recording:armed');
  }

  recordAction(action: string): void {
    this.assert(this.script.kind !== 'idle', 'ordinary recording or repair must be armed first');
    if (this.script.kind === 'ordinary' && this.script.phase === 'armed') {
      this.script.phase = 'recording';
    }
    this.script.actions.push(action);
    this.commit(`action:${action}`);
  }

  beginRepair(sourcePath: string): void {
    this.assert(this.script.kind !== 'repair', 'repair transaction already active');
    this.assert(this.script.kind === 'idle', 'repair is disjoint from ordinary recording');
    this.script = {
      kind: 'repair',
      transaction: {
        sourcePath,
        phase: 'armed',
        acceptedSteps: [],
      },
      actions: [],
    };
    this.commit('repair:armed');
  }

  stampCorrectiveResume(expectedFrom: number): void {
    const repair = this.requireRepair();
    repair.transaction.pendingResume = {
      expectedFrom,
      actionsCountAtDivergence: repair.actions.length,
    };
    this.commit(`repair:resume-stamped:${expectedFrom}`);
  }

  admitCorrectiveResume(from: number): void {
    const repair = this.requireRepair();
    const pending = repair.transaction.pendingResume;
    this.assert(pending !== undefined, 'no corrective resume is pending');
    this.assert(pending.expectedFrom === from, 'resume ordinal does not match the watermark');
    this.assert(
      repair.actions.length > pending.actionsCountAtDivergence,
      'no corrective action was recorded',
    );
    repair.transaction.pendingResume = undefined;
    this.commit(`repair:resume-admitted:${from}`);
  }

  completeRepair(): void {
    const repair = this.requireRepair();
    this.assert(!repair.transaction.pendingResume, 'corrective resume has not been admitted');
    this.assert(repair.transaction.phase === 'armed', 'repair cannot complete from this phase');
    repair.transaction.phase = 'complete';
    this.commit('repair:complete');
  }

  publishActive(): void {
    this.assert(this.script.kind !== 'repair', 'active publication is unavailable during repair');
    this.assert(this.script.kind === 'ordinary', 'ordinary recording has no actions');
    this.assert(this.script.phase !== 'published', 'artifact was already published');
    this.assert(this.script.phase === 'recording', 'ordinary recording has no actions');
    this.assert(
      !this.script.actions.some((action) => action.includes('@unresolved')),
      'artifact contains an unresolved session-local ref',
    );
    serializeAdArtifact(this.script.actions);
    this.script.phase = 'published';
    this.commit('ordinary-recording:published');
  }

  private requireRepair(): Extract<SessionScriptState, { kind: 'repair' }> {
    this.assert(this.script.kind === 'repair', 'repair transaction is not active');
    return this.script;
  }

  private commit(event: string): void {
    this.revision += 1;
    this.events.push(event);
  }

  private assert(condition: boolean, message: string): asserts condition {
    if (condition) return;
    this.events.push(`rejected:${message}`);
    throw new Error(message);
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

function serializeAdArtifact(actions: readonly string[]): string {
  return `${actions.join('\n')}\n`;
}

const mutationSession = new LockedSessionState();
mutationSession.activateRefFrame();
mutationSession.attemptMutation('failed-click', false);
assert.equal(mutationSession.snapshot().refFrame?.status, 'expired');

const successfulMutationSession = new LockedSessionState();
successfulMutationSession.activateRefFrame();
successfulMutationSession.attemptMutation('successful-click', true);
assert.equal(successfulMutationSession.snapshot().refFrame?.status, 'expired');

const repairSession = new LockedSessionState();
repairSession.beginRepair('checkout.ad');
repairSession.stampCorrectiveResume(3);
assert.throws(() => repairSession.admitCorrectiveResume(3), /no corrective action/);
repairSession.recordAction('click text="Continue anyway"');
repairSession.admitCorrectiveResume(3);
repairSession.completeRepair();
assert.equal(
  repairSession.snapshot().script.kind === 'repair'
    ? repairSession.snapshot().script.transaction.phase
    : undefined,
  'complete',
);

const repairPublicationEvidence = await runRepairPublicationTransactionProbe();

const publicationSession = new LockedSessionState();
publicationSession.armOrdinaryRecording();
publicationSession.recordAction('fill text=${PASSWORD}');
publicationSession.publishActive();
assert.deepEqual(publicationSession.snapshot().script, {
  kind: 'ordinary',
  phase: 'published',
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
        correctiveResumeRequiresRecordedAction: true,
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
