import assert from 'node:assert/strict';

export type ScriptPublicationTarget = Readonly<{
  path: string;
  source: 'generated' | 'explicit' | 'healed-sibling';
  force: boolean;
}>;

type CorrectiveResumeWatermark = {
  expectedFrom: number;
  actionsCountAtDivergence: number;
};

type RepairPlatformCloseReceipt = Readonly<{
  operationKey: string;
}>;

type OrdinaryPublicationStatus =
  | { kind: 'armed' }
  | { kind: 'published'; path: string }
  | { kind: 'aborted'; reason: 'second-open' };

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

export type SessionScriptState =
  | { kind: 'inactive' }
  | {
      kind: 'ordinary';
      target: ScriptPublicationTarget;
      status: OrdinaryPublicationStatus;
      actions: string[];
    }
  | {
      kind: 'repair';
      sourcePath: string;
      boundary: number;
      target: ScriptPublicationTarget;
      watermark?: CorrectiveResumeWatermark;
      status: RepairPublicationStatus;
      actions: string[];
    };

type RepairArmRequest = {
  sourcePath: string;
  boundary: number;
  target: ScriptPublicationTarget;
};

type ExplicitCloseRequest = {
  operationKey: string;
  targetPath?: string;
  force?: boolean;
  performPlatformClose(): Promise<void>;
  publish(target: ScriptPublicationTarget): void;
};

export type ReplaySessionTransaction = Readonly<{
  arm(request: RepairArmRequest): void;
  stampCorrectiveResume(expectedFrom: number): void;
  admitCorrectiveResume(from: number): void;
  complete(): void;
}>;

export type SessionScriptPublication = Readonly<{
  publishActive(): void;
  finalizeExplicitClose(request: ExplicitCloseRequest): Promise<'committed' | 'aborted'>;
  abortForLifecycle(): void;
}>;

export type SessionScriptRecording = Readonly<{
  armOrdinary(target: ScriptPublicationTarget): void;
  record(action: string): void;
}>;

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

export class SessionScriptAggregate {
  private state: SessionScriptState = { kind: 'inactive' };

  readonly replay: ReplaySessionTransaction = {
    arm: (request) => this.armRepair(request),
    stampCorrectiveResume: (expectedFrom) => this.stampCorrectiveResume(expectedFrom),
    admitCorrectiveResume: (from) => this.admitCorrectiveResume(from),
    complete: () => this.completeRepair(),
  };

  readonly publication: SessionScriptPublication = {
    publishActive: () => this.publishActive(),
    finalizeExplicitClose: (request) => this.finalizeExplicitClose(request),
    abortForLifecycle: () => this.abortForLifecycle(),
  };

  readonly recording: SessionScriptRecording = {
    armOrdinary: (target) => this.armOrdinary(target),
    record: (action) => this.recordAction(action),
  };

  view(): SessionScriptState {
    return structuredClone(this.state);
  }

  private armOrdinary(target: ScriptPublicationTarget): void {
    assert.notEqual(this.state.kind, 'repair', 'ordinary recording is unavailable during repair');
    assert.equal(this.state.kind, 'inactive', 'ordinary recording is already active');
    this.state = { kind: 'ordinary', target, status: { kind: 'armed' }, actions: [] };
  }

  private recordAction(action: string): void {
    assert.notEqual(
      this.state.kind,
      'inactive',
      'ordinary recording or repair must be armed first',
    );
    assert.equal(this.state.status.kind, 'armed', 'script transaction no longer accepts actions');
    this.state.actions.push(action);
  }

  private armRepair(request: RepairArmRequest): void {
    assert.notEqual(this.state.kind, 'repair', 'repair transaction already active');
    assert.equal(this.state.kind, 'inactive', 'repair is disjoint from ordinary recording');
    this.state = {
      kind: 'repair',
      sourcePath: request.sourcePath,
      boundary: request.boundary,
      target: request.target,
      status: { kind: 'armed' },
      actions: [],
    };
  }

  private stampCorrectiveResume(expectedFrom: number): void {
    const repair = this.requireRepair();
    assert.equal(repair.status.kind, 'armed', 'repair no longer accepts a resume watermark');
    repair.watermark = {
      expectedFrom,
      actionsCountAtDivergence: repair.actions.length,
    };
  }

  private admitCorrectiveResume(from: number): void {
    const repair = this.requireRepair();
    const watermark = repair.watermark;
    assert.ok(watermark, 'no corrective resume is pending');
    assert.equal(watermark.expectedFrom, from, 'resume ordinal does not match the watermark');
    assert.ok(
      repair.actions.length > watermark.actionsCountAtDivergence,
      'no corrective action was recorded',
    );
    repair.watermark = undefined;
  }

  private completeRepair(): void {
    const repair = this.requireRepair();
    assert.equal(repair.watermark, undefined, 'corrective resume has not been admitted');
    assert.equal(repair.status.kind, 'armed', 'repair cannot complete from this phase');
    repair.status = { kind: 'complete' };
  }

  private publishActive(): void {
    assert.notEqual(this.state.kind, 'repair', 'active publication is unavailable during repair');
    assert.equal(this.state.kind, 'ordinary', 'ordinary recording has no actions');
    assert.notEqual(this.state.status.kind, 'published', 'artifact was already published');
    assert.equal(this.state.status.kind, 'armed', 'ordinary recording cannot be published');
    assert.ok(this.state.actions.length > 0, 'ordinary recording has no actions');
    assert.ok(
      !this.state.actions.some((action) => action.includes('@unresolved')),
      'artifact contains an unresolved session-local ref',
    );
    serializeAdArtifact(this.state.actions);
    this.state.status = { kind: 'published', path: this.state.target.path };
  }

  private async finalizeExplicitClose(
    request: ExplicitCloseRequest,
  ): Promise<'committed' | 'aborted'> {
    const repair = this.requireRepair();
    const terminal = terminalOutcome(repair.status);
    if (terminal) return terminal;

    const target = retarget(repair.target, request.targetPath, request.force);
    const completion = repairCompletion(repair.status);
    const receipt = await settlePlatformClose(closeReceipt(repair.status), request);

    repair.target = target;
    repair.status = { kind: 'close-succeeded', completion, receipt };
    if (completion === 'armed') {
      repair.status = { kind: 'aborted', reason: 'explicit-close-incomplete', receipt };
      return 'aborted';
    }

    request.publish(target);
    repair.status = { kind: 'committed', path: target.path, receipt };
    return 'committed';
  }

  private abortForLifecycle(): void {
    const repair = this.requireRepair();
    assert.equal(repair.status.kind, 'armed');
    repair.status = { kind: 'aborted', reason: 'lifecycle-incomplete' };
  }

  private requireRepair(): Extract<SessionScriptState, { kind: 'repair' }> {
    assert.equal(this.state.kind, 'repair', 'repair transaction is not active');
    return this.state;
  }
}

function serializeAdArtifact(actions: readonly string[]): string {
  return `${actions.join('\n')}\n`;
}
