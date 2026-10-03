import type {
  LeaseRequestInput,
  ManagedDeviceAllocatorPort,
  SupersedeLeaseRequestInput,
} from '@agent-device/contracts/managed-device-allocation';
import type { AllocationAction, AllocationDecisionMode } from './decision.ts';
import { decideAllocationAction } from './decision.ts';
import type { AllocationOperationRecord, AllocationOperationRef } from './record.ts';
import type { AllocationJournalLane } from './journal-lane.ts';
import { createAllocationJournalLane } from './journal-lane.ts';
import { createAllocationJournalActionRunner } from './journal-action-runtime.ts';
import { projectAllocationRecord } from './journal-projection.ts';
import type {
  AllocationJournalActionRunner,
  AllocationBindingHooks,
  AllocationJournalResult,
  JournalContext,
} from './journal-types.ts';
import type { AllocationOperationRead, AllocationOperationStore } from './store.ts';
import { abandoned, blocked, unreadableResult } from './journal-results.ts';

export type { AllocationBindingHooks, AllocationJournalResult } from './journal-types.ts';
// The remaining journal-types names are this package's public journal surface: the managed
// runtime binding (ADR 0021 §3) consumes them, and it lands after this move, so fallow sees no
// importer yet. Suppressed per name rather than baselined so the reason travels with the code.
// fallow-ignore-next-line unused-type
export type { AllocationJournalActionRunner } from './journal-types.ts';
// fallow-ignore-next-line unused-type
export type { AllocationJournalBlockReason } from './journal-types.ts';
// fallow-ignore-next-line unused-type
export type { AllocationJournalReason } from './journal-types.ts';
// fallow-ignore-next-line unused-type
export type { JournalContext } from './journal-types.ts';
// fallow-ignore-next-line unused-type
export type { PersistedTransition } from './journal-types.ts';

export type AllocationOperationJournal = Readonly<{
  allocate(input: LeaseRequestInput): Promise<AllocationJournalResult>;
  recover(ref: AllocationOperationRef): Promise<AllocationJournalResult>;
  cancel(ref: AllocationOperationRef): Promise<AllocationJournalResult>;
  release(ref: AllocationOperationRef): Promise<AllocationJournalResult>;
  supersede(input: SupersedeLeaseRequestInput): Promise<AllocationJournalResult>;
  read(ref: AllocationOperationRef): AllocationOperationRead;
  list(): AllocationOperationRead[];
}>;

type JournalSetup = Readonly<{
  store: AllocationOperationStore;
  allocator: ManagedDeviceAllocatorPort;
  binding?: AllocationBindingHooks;
  now: () => number;
  lane: AllocationJournalLane;
}>;

type ExecuteOperation = (
  record: AllocationOperationRecord,
  mode: AllocationDecisionMode,
  context: JournalContext,
) => Promise<AllocationJournalResult>;

type JournalServices = JournalSetup &
  Readonly<{
    actions: AllocationJournalActionRunner;
    execute: ExecuteOperation;
    project(record: AllocationOperationRecord): AllocationJournalResult;
  }>;

export function createAllocationOperationJournal(
  options: Readonly<{
    store: AllocationOperationStore;
    allocator: ManagedDeviceAllocatorPort;
    binding?: AllocationBindingHooks;
    now?: () => number;
  }>,
): AllocationOperationJournal {
  const setup: JournalSetup = {
    ...options,
    now: options.now ?? Date.now,
    lane: createAllocationJournalLane({
      allocator: options.allocator,
      store: options.store,
      now: options.now ?? Date.now,
    }),
  };
  const project = projectAllocationRecord;
  function execute(
    record: AllocationOperationRecord,
    mode: AllocationDecisionMode,
    context: JournalContext,
  ): Promise<AllocationJournalResult> {
    return executeOperation({ ...setup, actions, execute, project }, record, mode, context);
  }

  const actions: AllocationJournalActionRunner = createAllocationJournalActionRunner({
    allocator: setup.allocator,
    binding: setup.binding,
    store: setup.store,
    now: setup.now,
    execute,
    project,
  });
  return createJournalServices({ ...setup, actions, execute, project });
}

function createJournalServices(services: JournalServices): AllocationOperationJournal {
  return Object.freeze({
    allocate: (input) => allocateOperation(services, input),
    recover: (ref) => referenceOperation(services, ref, 'recover'),
    cancel: (ref) => referenceOperation(services, ref, 'cancel'),
    release: (ref) => referenceOperation(services, ref, 'release'),
    supersede: (input) => supersedeOperation(services, input),
    read: (ref) => services.store.read(ref),
    list: () => services.store.list(),
  });
}

function allocateOperation(
  services: JournalServices,
  input: LeaseRequestInput,
): Promise<AllocationJournalResult> {
  return services.lane.withLock(input.requesterId, async () => {
    const opened = services.lane.open(input);
    if ('status' in opened) return opened;
    return services.execute(opened.record, 'new', {
      signal: input.signal,
      requestInput: input,
    });
  });
}

function referenceOperation(
  services: JournalServices,
  ref: AllocationOperationRef,
  mode: Extract<AllocationDecisionMode, 'recover' | 'cancel' | 'release'>,
): Promise<AllocationJournalResult> {
  return services.lane.withLock(ref.requesterId, async () => {
    const current = readRequired(services.store, ref);
    if ('status' in current) return current;
    return services.execute(current.record, mode, {});
  });
}

function supersedeOperation(
  services: JournalServices,
  input: SupersedeLeaseRequestInput,
): Promise<AllocationJournalResult> {
  const invalid = validateSupersessionInput(input);
  if (invalid) return Promise.resolve(invalid);
  return services.lane.withLock(input.requesterId, async () => {
    const prior = services.lane.expectedPrior(input);
    if ('status' in prior) return prior;
    const allocatorCheck = checkAllocatorInstance(services.allocator, prior.record);
    if (allocatorCheck) return allocatorCheck;
    const liveBinding = liveBindingSupersession(prior.record, input);
    if (liveBinding) return liveBinding;
    const opened = services.lane.open(input.replacement, prior.record);
    if ('status' in opened) return opened;
    return services.execute(opened.record, 'supersede', {
      signal: input.replacement.signal,
      supersedeInput: input,
    });
  });
}

function validateSupersessionInput(
  input: SupersedeLeaseRequestInput,
): AllocationJournalResult | undefined {
  if (input.replacement.requesterId !== input.requesterId) {
    return blocked('payload-mismatch', 'supersession requester does not match its replacement');
  }
  return input.replacement.requestGeneration > input.expectedRequestGeneration &&
    Number.isInteger(input.replacement.requestGeneration)
    ? undefined
    : blocked('payload-mismatch', 'supersession replacement generation is not newer');
}

function liveBindingSupersession(
  prior: AllocationOperationRecord,
  input: SupersedeLeaseRequestInput,
): AllocationJournalResult | undefined {
  if (prior.attemptKey === input.replacement.attemptKey) {
    return blocked('payload-mismatch', 'supersession must use a new attempt key', prior);
  }
  if (prior.phase.status !== 'granted') return undefined;
  return blocked(
    prior.release === 'released' ? 'invalid-transition' : 'already-granted',
    'supersession cannot revoke a live managed binding in this slice',
    prior,
  );
}

function executeOperation(
  services: JournalServices,
  record: AllocationOperationRecord,
  mode: AllocationDecisionMode,
  context: JournalContext,
): Promise<AllocationJournalResult> {
  if (context.signal?.aborted) return Promise.resolve(abandoned(record));
  const allocatorCheck = checkAllocatorInstance(services.allocator, record);
  if (allocatorCheck) return Promise.resolve(allocatorCheck);
  return executeAction(
    services.actions,
    services.project,
    record,
    decideAllocationAction(record, mode),
    context,
    mode,
  );
}

type AllocatorAction = Extract<
  AllocationAction,
  { kind: 'request' | 'supersede' | 'lookup' | 'cancel' }
>;
type BindingAction = Extract<AllocationAction, { kind: 'publish' | 'cleanup' | 'release' }>;

function executeAction(
  actions: AllocationJournalActionRunner,
  project: (record: AllocationOperationRecord) => AllocationJournalResult,
  record: AllocationOperationRecord,
  action: AllocationAction,
  context: JournalContext,
  mode: AllocationDecisionMode,
): Promise<AllocationJournalResult> {
  if (isAllocatorAction(action))
    return executeAllocatorAction(actions, record, action, context, mode);
  if (isBindingAction(action)) return executeBindingAction(actions, record, action, context);
  if (action.kind === 'pending' || action.kind === 'terminal')
    return Promise.resolve(project(record));
  return Promise.resolve(blocked(action.reason, action.message, record));
}

function executeAllocatorAction(
  actions: AllocationJournalActionRunner,
  record: AllocationOperationRecord,
  action: AllocatorAction,
  context: JournalContext,
  mode: AllocationDecisionMode,
): Promise<AllocationJournalResult> {
  switch (action.kind) {
    case 'request':
      return actions.request(record, context);
    case 'supersede':
      return actions.supersede(record, context);
    case 'lookup':
      return actions.lookup(record, mode, context.signal);
    case 'cancel':
      return actions.cancel(record);
  }
}

function executeBindingAction(
  actions: AllocationJournalActionRunner,
  record: AllocationOperationRecord,
  action: BindingAction,
  context: JournalContext,
): Promise<AllocationJournalResult> {
  switch (action.kind) {
    case 'publish':
      return actions.publish(record, action, context.signal);
    case 'cleanup':
      return actions.cleanup(record, action);
    case 'release':
      return actions.release(record);
  }
}

function isAllocatorAction(action: AllocationAction): action is AllocatorAction {
  return (
    action.kind === 'request' ||
    action.kind === 'supersede' ||
    action.kind === 'lookup' ||
    action.kind === 'cancel'
  );
}

function isBindingAction(action: AllocationAction): action is BindingAction {
  return action.kind === 'publish' || action.kind === 'cleanup' || action.kind === 'release';
}

function checkAllocatorInstance(
  allocator: ManagedDeviceAllocatorPort,
  record: AllocationOperationRecord,
): AllocationJournalResult | undefined {
  return record.allocatorInstanceId === allocator.instanceId
    ? undefined
    : blocked(
        'payload-mismatch',
        'allocation operation belongs to a different allocator instance',
        record,
      );
}

function readRequired(
  store: AllocationOperationStore,
  ref: AllocationOperationRef,
): Readonly<{ record: AllocationOperationRecord }> | AllocationJournalResult {
  const read = store.read(ref);
  if (read.status === 'found') return { record: read.record };
  if (read.status === 'missing')
    return blocked('operation-missing', 'allocation operation record is missing');
  return unreadableResult(read);
}
