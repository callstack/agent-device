import type { DeviceLease, LeaseLifecycleContext } from '@agent-device/contracts/device';
import { errorMessage } from '@agent-device/kernel/errors';
import type { RevylPlatform } from './device.ts';
import { isRevylSessionGone, type RevylClient } from './revyl-client.ts';
import {
  startRevylSession,
  stopRevylSession,
  type RevylRentedSession,
  type RevylSession,
  type RevylStart,
} from './revyl-session.ts';
import type { RevylStartRequest } from './session-allocation.ts';
import { revylSessionIdForLease } from './session-identity.ts';

const CREATE_ANSWER_BUDGET_MS = 120_000;
const STOP_ANSWER_BUDGET_MS = 30_000;

export type RevylStopOutcome = Readonly<{
  session: RevylRentedSession;
  data?: Record<string, unknown>;
}> &
  (Readonly<{ cleanup: 'confirmed' }> | Readonly<{ cleanup: 'uncertain'; failure: string }>);

type RevylUncertainStop = Extract<RevylStopOutcome, { cleanup: 'uncertain' }>;
type RevylConfirmedStop = Extract<RevylStopOutcome, { cleanup: 'confirmed' }>;

type StopWork = Readonly<{ pending: Promise<RevylStopOutcome> }>;
type RevylLeaseState =
  | { phase: 'starting'; rented?: RevylRentedSession }
  | { phase: 'ready'; session: RevylSession }
  | {
      phase: 'stopping';
      disposal: Promise<RevylStopOutcome | undefined>;
      rented?: RevylRentedSession;
      stop?: StopWork;
    }
  | { phase: 'stop-failed'; outcome: RevylUncertainStop; stop?: StopWork }
  | { phase: 'closed'; outcome?: RevylConfirmedStop };

export class RevylLeaseOwner {
  private state: RevylLeaseState = { phase: 'starting' };
  readonly creation: Promise<RevylStart>;
  private readonly client: RevylClient;
  readonly lease: DeviceLease;
  readonly request: RevylStartRequest;
  private readonly closed: () => void;

  constructor(
    client: RevylClient,
    lease: DeviceLease,
    platform: RevylPlatform,
    request: RevylStartRequest,
    context: LeaseLifecycleContext | undefined,
    closed: () => void,
  ) {
    this.client = client;
    this.lease = lease;
    this.request = request;
    this.closed = closed;
    // The microtask starts only after the runtime publishes this owner in its map.
    this.creation = Promise.resolve().then(async () => {
      let result: RevylStart;
      try {
        result = await startRevylSession(
          client,
          lease,
          {
            platform,
            appUrl: request.appUrl,
            deviceModel: request.deviceModel,
            osVersion: request.osVersion,
            ...(context?.signal === undefined ? {} : { signal: context.signal }),
            ...(context?.deadline === undefined ? {} : { deadline: context.deadline }),
          },
          (rented) => this.recordRent(rented),
        );
      } catch (error) {
        result = {
          status: 'failed',
          error,
          rented: { sessionId: revylSessionIdForLease(lease.leaseId) },
        };
      }
      if (this.state.phase === 'starting') {
        if (result.status === 'ready') this.state = { phase: 'ready', session: result.session };
        else if (result.rented === undefined) this.close();
        else this.recordRent(result.rented);
      }
      return result;
    });
    void this.creation
      .then(async (result) => {
        if (result.status === 'failed' && result.rented !== undefined) await this.endFailedStart();
      })
      .catch(() => undefined);
  }

  get session(): RevylSession | undefined {
    return this.state.phase === 'ready' ? this.state.session : undefined;
  }

  get releasing(): boolean {
    return this.state.phase !== 'starting' && this.state.phase !== 'ready';
  }

  private recordRent(rented: RevylRentedSession): void {
    const state = this.state;
    if (state.phase === 'starting' || state.phase === 'stopping') state.rented = rented;
    else if (state.phase === 'stop-failed')
      this.state = { ...state, outcome: { ...state.outcome, session: rented } };
  }

  endFailedStart(): Promise<RevylStopOutcome | undefined> {
    return this.state.phase === 'stop-failed' ? Promise.resolve(this.state.outcome) : this.end();
  }

  end(): Promise<RevylStopOutcome | undefined> {
    const previous = this.state;
    if (previous.phase === 'closed') return Promise.resolve(previous.outcome);
    if (previous.phase === 'stopping') return previous.disposal;
    const stop = previous.phase === 'stop-failed' ? previous.stop : undefined;
    const rented =
      previous.phase === 'starting'
        ? previous.rented
        : previous.phase === 'ready'
          ? previous.session
          : previous.outcome.session;
    const disposal = Promise.resolve().then(async () => await this.dispose());
    this.state = {
      phase: 'stopping',
      disposal,
      ...(rented === undefined ? {} : { rented }),
      ...(stop === undefined ? {} : { stop }),
    };
    return disposal;
  }

  private async dispose(): Promise<RevylStopOutcome | undefined> {
    const created = await withinBudget(this.creation, CREATE_ANSWER_BUDGET_MS);
    if (created === undefined) {
      const outcome = this.uncertain('Revyl start has not answered within its disposal budget.');
      this.state = { phase: 'stop-failed', outcome };
      // No stop can confirm absence before the create answers. Its eventual answer re-enters the same owner.
      void this.creation.then(async () => await this.end()).catch(() => undefined);
      return outcome;
    }
    const target =
      created.status === 'ready'
        ? { runId: created.session.runId, sessionId: created.session.sessionId }
        : created.rented;
    if (target === undefined) {
      this.close();
      return undefined;
    }
    const data = created.status === 'ready' ? allocationResult(created.session) : undefined;
    const state = this.state;
    if (state.phase !== 'stopping') throw new TypeError('Revyl disposal lost its owner');
    const pending = state.stop?.pending ?? this.stop(target, data);
    const stop = { pending };
    state.stop = stop;
    const outcome = await withinBudget(pending, STOP_ANSWER_BUDGET_MS);
    if (outcome === undefined) {
      const uncertain = {
        ...this.uncertain('Revyl stop has not answered within its disposal budget.'),
        ...(data === undefined ? {} : { data }),
      };
      this.state = { phase: 'stop-failed', outcome: uncertain, stop };
      // A late confirmation closes the owner; a late refusal leaves the same session available for retry.
      void pending
        .then((late) => {
          if (this.state.phase === 'stop-failed' && this.state.stop === stop) this.finish(late);
        })
        .catch(() => undefined);
      return uncertain;
    }
    this.finish(outcome);
    return outcome;
  }

  private async stop(
    target: RevylRentedSession,
    data?: Record<string, unknown>,
  ): Promise<RevylStopOutcome> {
    const result = { session: target, ...(data === undefined ? {} : { data }) };
    try {
      await stopRevylSession(this.client, target.sessionId);
      return { ...result, cleanup: 'confirmed' };
    } catch (error) {
      return isRevylSessionGone(error)
        ? { ...result, cleanup: 'confirmed' }
        : { ...result, cleanup: 'uncertain', failure: errorMessage(error) };
    }
  }

  private uncertain(failure: string): RevylUncertainStop {
    const state = this.state;
    const target = state.phase === 'stopping' ? state.rented : undefined;
    return {
      cleanup: 'uncertain',
      session: target ?? { sessionId: revylSessionIdForLease(this.lease.leaseId) },
      failure,
    };
  }

  private finish(outcome: RevylStopOutcome): void {
    if (outcome.cleanup === 'confirmed') this.close(outcome);
    else this.state = { phase: 'stop-failed', outcome };
  }

  private close(outcome?: RevylConfirmedStop): void {
    this.state = { phase: 'closed', ...(outcome === undefined ? {} : { outcome }) };
    this.closed();
  }
}

async function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function allocationResult(session: RevylSession): Record<string, unknown> {
  return {
    revylRunId: session.runId,
    providerSessionId: session.sessionId,
    device: session.device,
  };
}
