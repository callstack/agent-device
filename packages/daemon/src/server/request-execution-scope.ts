import { heldKeyedLockKeys } from '@agent-device/kernel/keyed-lock';
import { LEASE_REASONS } from '@agent-device/contracts/lease-scope';
import { restrictRemoteHostInputs } from './remote-host-input-policy.ts';
import type { EnvMap, HostEnvironment } from '@agent-device/kernel/source-value';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  resolveSessionRequestLog,
  resolveSessionRunnerLogPath,
} from '@agent-device/daemon-contracts/session-artifact-paths';
import {
  createOwnerScopedDeviceClaimReconciler,
  type ClaimRecoveryGatewayFactory,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import type { LeaseLifecycleProvider, ProviderAppCatalog } from '@agent-device/contracts/device';
import * as output from '../resources/artifact-tracking.ts';
import {
  emitDiagnostic,
  getDiagnosticsMeta,
  updateDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import {
  type DaemonCommandContext,
  contextFromFlags as contextFromFlagsWithLog,
  requestCwd,
} from '../core/context.ts';
import { assertSessionSelectorMatches } from '../core/session-selector.ts';
import { resolveCallerScopeRoot, resolveSessionScope } from '../sessions/session-routing.ts';
import { deriveWebSessionIdentity } from '../core/session-tenant-scope.ts';
import {
  assertProviderLeaseRequestNamesSession,
  assertRequestLeaseAdmission,
  assertRequestLeaseAdmissionPreflight,
  assertRequestTenantAdmission,
  resolveRequestSessionName,
  resolveRequestSessionRef,
  type ResolveRequestSessionRef,
  scopeRequestSession,
  withTenantAdmissionOnRoutingError,
} from '../sessions/request-admission.ts';
import { isBoundedCompositeRequest, resolveLeaseScope } from '../core/lease-context.ts';
import {
  admitRequestLeaseForLockedScope,
  inspectSessionProviderReleaseOnClose,
} from '../sessions/lease-lifecycle.ts';
import {
  prepareLockedRequestBinding,
  resolveBoundedClaimDevice,
  resolveRequestExecutionLockPlan,
  sessionExecutionLockKey,
  type RequestExecutionLockPlan,
} from './request-binding.ts';
import {
  beginOpenDeviceWait,
  findSessionDeviceConflict,
  readOpenWaitBudgetMs,
} from '../sessions/open-device-contention-wait.ts';
import {
  createRequestExecutionLocks,
  createSessionExecutionLock,
  withRequestExecutionLockKeys,
} from './request-execution-locks.ts';
import {
  getRequestDeadlineMs,
  isRequestCanceled,
  throwIfRequestCanceled,
} from '@agent-device/host-kit/request';
import {
  assertSameOpenOwner,
  SessionCoordinator,
  type SessionStore,
} from '../core/session-store.ts';
import { finalizeDaemonResponse } from './request-finalization.ts';
import { refreshRecordingHealth } from '../sessions/request-recording-health.ts';
import { inactiveLease, runAdmittedLeaseWork } from './request-lease-work.ts';
import { assertMacOsAppLeaseProcess } from '../resources/macos-app-lease.ts';
import {
  ignoresSessionLease,
  shouldBlockForInvalidRecording,
  shouldLockSessionExecution,
  shouldValidateSessionSelector,
} from '../core/daemon-command-registry.ts';
import {
  shouldRecordEventForRequest,
  type BoundJournal,
} from '@agent-device/session-journal/session-event-log';
import type {
  Admission,
  LeaseSessionEnd,
  LockedAttempt,
  NeedSettlement,
} from './lease-session-end.ts';
import { deviceLeaseBusyError } from '../resources/lease-registry-scope.ts';
import type { LeaseRegistry } from '../resources/lease-registry.ts';
import { recordEndedLease } from '../core/request-ended-leases.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../core/session-state.ts';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import {
  createRequestRuntimeBindings,
  type BindDeviceRuntime,
  type BindExactDeviceRuntime,
  type InspectDeviceRuntimeFacts,
  type RequestRuntimeBindings,
} from '../core/request-runtime-binding.ts';
import {
  createDeviceClaimAdmission,
  type DeviceClaimAdmission,
} from '../resources/device/device-claim-admission.ts';
import {
  applyCommandDefaults,
  resolveCommandDeviceClaimPolicy,
} from '@agent-device/command-registry/registry';
import type { DaemonPlatformServices } from '../core/platform-services.ts';
import {
  assertDaemonPolicyAdmitsDevice,
  assertDaemonPolicyAdmitsRequest,
} from '../core/daemon-policy.ts';
import type { DaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';
import { deviceClaimConflictError } from '../resources/device/device-claim-conflict.ts';
import {
  requestDispatchLedger,
  type RequestDispatchLedger,
} from '../core/request-dispatch-ledger.ts';

// Production daemon wiring owns one LeaseRegistry per process; scoping locks by registry keeps
// test and embedded routers isolated without changing process-level serialization there.
const leaseRegistryExecutionLocks = new WeakMap<LeaseRegistry, Map<string, Promise<unknown>>>();
const requestScopeFinalizers = new WeakMap<
  RequestExecutionScope,
  (response: DaemonResponse) => DaemonResponse
>();

export type RequestExecutionScope = AsyncDisposable & {
  /** The environment and working directory of the daemon serving this request. */
  host: HostEnvironment;
  req: DaemonRequest;
  command: string;
  sessionName: string;
  admittedRef?: SessionRef;
  requestLogPath: string;
  runnerLogPath: string;
  runAdmitted<T>(
    task: () => Promise<T>,
    admitted?: { ref: SessionRef | undefined; assertSuccessorCurrent?: () => void },
  ): Promise<T>;
  runLocked<T>(task: () => Promise<T>): Promise<T>;
  /** Takes an available session lock and runs `task` if the admitted lifetime is still live. */
  tryRunUnderSessionLock(ref: SessionRef, task: () => Promise<void>): Promise<void>;
  bindJournal(req: DaemonRequest, ref: SessionRef | undefined): DaemonRequest;
  recordFinished(req: DaemonRequest, response: DaemonResponse): void;
  retainDeviceExecutionLock(deviceId: string): Promise<void>;
  bindDevice: BindDeviceRuntime;
  /** Root-composed platform services for this request's asks that bind no device runtime. */
  platformServices: DaemonPlatformServices;
  inspectFacts: InspectDeviceRuntimeFacts;
  bindExactDevice: BindExactDeviceRuntime;
  /** The request's mutations, recorded by every bound operation this scope hands out. */
  dispatchLedger: RequestDispatchLedger;
  throwIfCanceled(): void;
};

export type LockedRequestScope = {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  existingSession: SessionState | undefined;
  existingRef: SessionRef | undefined;
  resolveSessionRef: ResolveRequestSessionRef;
  retainDeviceExecutionLock(deviceId: string): Promise<void>;
  bindDevice: BindDeviceRuntime;
  platformServices: DaemonPlatformServices;
  inspectFacts: InspectDeviceRuntimeFacts;
  bindExactDevice: BindExactDeviceRuntime;
  dispatchLedger: RequestDispatchLedger;
  throwIfCanceled(): void;
  contextFromFlags(
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ): DaemonCommandContext;
  handlerContextFromFlags(
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ): DaemonCommandContext;
};

type LockedRequestScopeResult =
  | { type: 'scope'; scope: LockedRequestScope }
  | { type: 'response'; response: DaemonResponse };

export async function createRequestExecutionScope(params: {
  host: HostEnvironment;
  req: DaemonRequest;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  deviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  platformServices: DaemonPlatformServices;
  claimRecoveryGateway: ClaimRecoveryGatewayFactory;
  trackClaimRecoveryDisposal: (disposal: Promise<void>) => void;
  platformRequestScope: PlatformRequestScope;
  leaseSessionEnd?: Pick<LeaseSessionEnd, 'settlementFor' | 'closingAt'>;
  providerAppCatalog?: ProviderAppCatalog;
  pluginInventory?: readonly PluginInventoryEntry[];
  daemonPolicy?: DaemonPolicy;
}): Promise<RequestExecutionScope> {
  const { sessionStore, leaseRegistry } = params;
  const unscopedReq = restrictRemoteHostInputs(params.req);
  const tenantScopedReq = scopeRequestSession(unscopedReq);
  // A nested batch or replay step arrives with the identity of the request that spawned it, and its
  // own name is already the store key.
  const webSession =
    params.req.internal?.webSession ??
    deriveWebSessionIdentity(
      params.req.session,
      tenantScopedReq,
      withTenantAdmissionOnRoutingError(unscopedReq, () => resolveSessionScope(tenantScopedReq)),
    );
  let scopedReq = applyRequestCommandDefaults({
    ...tenantScopedReq,
    internal: { ...tenantScopedReq.internal, webSession },
  });

  const command = scopedReq.command;
  const startedAtMs = Date.now();
  const attachesToSession = shouldLockSessionExecution(command);
  const readsSessionLease = !ignoresSessionLease(command);
  const sessionName = resolveRequestSessionName({ scopedReq, unscopedReq, sessionStore });
  const sessionDir = sessionStore.resolveSessionDir(sessionName);
  const requestLog = resolveSessionRequestLog({
    sessionDir,
    session: sessionName,
    requestId: output.requestDiagnosticsRecordId(scopedReq),
    directory: 'request-records',
  });
  const requestLogPath = requestLog.path;
  const runnerLogPath = resolveSessionRunnerLogPath(sessionDir);
  updateDiagnosticsScope({
    session: sessionName,
    logPath: requestLog.path,
    logRecord: requestLog.ref,
  });
  emitDiagnostic({
    level: 'info',
    phase: 'request_start',
    data: {
      publicSession: scopedReq.session,
      effectiveSession: sessionName,
      command: scopedReq.command,
      tenant: scopedReq.meta?.tenantId,
      isolation: scopedReq.meta?.sessionIsolation,
      requestLogPath,
      runnerLogPath,
    },
  });
  const coordinator = new SessionCoordinator(sessionStore);
  let finishEvent: ReturnType<BoundJournal['beginRequest']> | undefined;
  const startJournal = (journal: BoundJournal): void => {
    if (finishEvent || !shouldRecordEventForRequest(scopedReq)) return;
    finishEvent = journal.beginRequest(scopedReq, startedAtMs);
  };
  scopedReq = {
    ...scopedReq,
    internal: { ...scopedReq.internal, onJournalPublished: startJournal },
  };
  const recordFinished: RequestExecutionScope['recordFinished'] = (req, response) =>
    finishEvent?.(req, response);
  return await planExecutionScope();

  async function planExecutionScope(): Promise<RequestExecutionScope> {
    const devicePin = scopedReq.meta?.devicePin;
    const pinPolicy = devicePin
      ? await import('@agent-device/device-selection/device-selection-resolver')
      : undefined;
    if (devicePin && pinPolicy) pinPolicy.assertRequestHonorsDevicePin(devicePin, scopedReq);
    if (params.daemonPolicy) assertDaemonPolicyAdmitsRequest(params.daemonPolicy, scopedReq);
    const readAddressed = () =>
      sessionStore.lookup(sessionName) ?? params.leaseSessionEnd?.closingAt(sessionName);
    const preflightRef = readAddressed();
    const preflightSession = preflightRef?.session;
    assertProviderLeaseRequestNamesSession(scopedReq, preflightSession);
    assertRequestLeaseAdmissionPreflight(scopedReq, preflightSession);
    // Parse the budget once, before resolving the target device or taking any lock. The lock plan
    // still supplies the device to wait for, but an out-of-range budget is refused before either.
    const openWaitBudgetMs =
      scopedReq.command === 'open' ? readOpenWaitBudgetMs(scopedReq) : undefined;
    const executionLocks = getLeaseRegistryExecutionLocks(leaseRegistry);
    const outerKeys = heldKeyedLockKeys(executionLocks);
    const hasOuterLocks = outerKeys.length > 0;
    const sessionKey = sessionExecutionLockKey(sessionName);
    const signal = params.platformRequestScope.signal;
    const waitDeadline = openWaitBudgetMs === undefined ? Infinity : startedAtMs + openWaitBudgetMs;
    const leaseAdmission = { ...params, env: params.host.env, inspectOnly: true };
    const settlementFor = (ref: SessionRef | undefined) =>
      ref && params.leaseSessionEnd?.settlementFor(ref.lifetime);
    const isRetryableClose = (ref: SessionRef | undefined) => {
      const lease = ref?.session.lease;
      return command === 'close' && lease && leaseRegistry.canRetryClose(lease.leaseId);
    };
    const isInactive = (ref: SessionRef | undefined) => {
      const lease = readsSessionLease && ref?.session.lease;
      return Boolean(
        lease && !isRetryableClose(ref) && !leaseRegistry.inspectActiveLease(lease.leaseId),
      );
    };
    const authenticateExpiry = async (ref: SessionRef, leaseId: string) => {
      assertRequestTenantAdmission(unscopedReq, ref.session);
      const presented = resolveLeaseScope(scopedReq).leaseId;
      const successor =
        command === 'open' && presented && presented !== leaseId
          ? assertRequestLeaseAdmission(scopedReq, leaseRegistry, undefined, leaseAdmission)
          : undefined;
      if (!successor) {
        resolveRequestSessionRef(scopedReq, ref);
        return undefined;
      }
      const isCurrent = leaseRegistry.pinActiveLease(successor.leaseId);
      if (successor.backend === 'macos-app') {
        await assertMacOsAppLeaseProcess(successor);
        throwIfRequestCanceled(scopedReq.meta?.requestId);
        if (!isCurrent()) throw inactiveLease();
        assertRequestLeaseAdmission(scopedReq, leaseRegistry, undefined, leaseAdmission);
      }
      return isCurrent;
    };
    const resolveExpiryAdmission = async (
      ref: SessionRef | undefined,
      settlement = settlementFor(ref),
    ): Promise<Admission> => {
      if (!ref || !readsSessionLease) return { kind: 'admitted' };
      const lease = ref.session.lease;
      if (!lease || (!settlement && !isInactive(ref))) return { kind: 'admitted' };
      const successorIsCurrent = await authenticateExpiry(ref, lease.leaseId);
      if (!settlement) {
        leaseRegistry.consumeExpiredLease(lease.leaseId);
        settlement = settlementFor(ref);
        if (!settlement && !isInactive(ref)) return { kind: 'admitted' };
      }
      if (!settlement || hasOuterLocks) return { kind: 'refused', error: inactiveLease() };
      return {
        kind: 'need-settlement',
        settlement,
        leaseId: lease.leaseId,
        successorIsCurrent,
        ownerLeaseId: successorIsCurrent ? undefined : lease.leaseId,
      };
    };
    const readNestedAddress = async () => {
      const addressed = readAddressed();
      const expiry = await resolveExpiryAdmission(addressed);
      if (expiry.kind !== 'admitted')
        throw expiry.kind === 'refused' ? expiry.error : inactiveLease();
      return addressed;
    };
    const admitLease = (ref: SessionRef | undefined, assertCurrent?: () => void) => {
      assertCurrent?.();
      return admitRequestLeaseForLockedScope({
        env: params.host.env,
        req: scopedReq,
        session: ref?.session,
        leaseRegistry,
        providerAppCatalog: params.providerAppCatalog,
        pluginInventory: params.pluginInventory,
        daemonPolicy: params.daemonPolicy,
      });
    };
    const waitForSettlement = async (attempt: NeedSettlement) => {
      const { awaitExpiry } = await import('./lease-session-end.ts');
      const deadline = getRequestDeadlineMs(scopedReq.meta?.requestId) ?? Infinity;
      const settled = await awaitExpiry(
        attempt.settlement.done,
        signal,
        Math.min(waitDeadline, deadline),
      );
      throwIfRequestCanceled(scopedReq.meta?.requestId);
      if (attempt.ownerLeaseId) {
        if (settled && command === 'close' && attempt.settlement.takeReceipt())
          recordEndedLease(scopedReq, attempt.ownerLeaseId);
        throw inactiveLease();
      }
      if (!attempt.successorIsCurrent?.()) throw inactiveLease();
      if (!settled) throw leaseRegistry.leaseEndRefusal(attempt.leaseId) ?? deviceLeaseBusyError();
      return attempt.successorIsCurrent;
    };
    let requestExecutionLocks: ReturnType<typeof createRequestExecutionLocks> | undefined;
    const dispatchLedger = requestDispatchLedger(scopedReq);
    const { claimAdmission, runtimeBindings } = createRequestDeviceAccess({
      env: params.host.env,
      req: scopedReq,
      command,
      sessionName,
      dispatchLedger,
      workspace: requestCwd(scopedReq, params.host),
      callerCwd: scopedReq.meta?.cwd,
      stateDir: sessionStore.resolveDaemonStateDir(),
      deviceRuntimeGateway: params.deviceRuntimeGateway,
      platformRequestScope: params.platformRequestScope,
      daemonPolicy: params.daemonPolicy,
      admitDevicePin:
        devicePin && pinPolicy
          ? (device) => pinPolicy.assertDeviceHonorsPin(devicePin, device, scopedReq.flags)
          : undefined,
      claimRecoveryGateway: params.claimRecoveryGateway,
      trackClaimRecoveryDisposal: params.trackClaimRecoveryDisposal,
      sessionStore,
    });

    let bindingCleanup: Promise<void> | undefined;
    const disposeBindings = (): Promise<void> => {
      bindingCleanup ??= (async () => {
        try {
          await runtimeBindings[Symbol.asyncDispose]();
        } finally {
          await claimAdmission[Symbol.asyncDispose]();
        }
      })();
      return bindingCleanup;
    };
    const runAdmittedAttempt = async <T>(
      ref: SessionRef | undefined,
      task: () => Promise<T>,
      successorIsCurrent: (() => boolean) | undefined,
    ): Promise<LockedAttempt<T>> => {
      let acting = false;
      try {
        const value = await scope.runAdmitted(
          async () => {
            acting = true;
            return await task();
          },
          {
            ref,
            assertSuccessorCurrent: () => {
              if (successorIsCurrent && !successorIsCurrent()) throw inactiveLease();
            },
          },
        );
        return { kind: 'admitted', value };
      } catch (error) {
        if (
          acting ||
          !isInactive(ref) ||
          !(error instanceof AppError) ||
          error.details?.reason !== LEASE_REASONS.notFound.reason
        )
          throw error;
        const expiry = await resolveExpiryAdmission(ref);
        return expiry.kind === 'admitted' ? { kind: 'replan' } : expiry;
      } finally {
        if (acting) await Promise.allSettled([disposeBindings()]);
      }
    };

    const runLockPlan = async <T>(
      lockPlan: RequestExecutionLockPlan,
      task: () => Promise<T>,
      successorIsCurrent: (() => boolean) | undefined,
      expiryProbe: boolean,
    ): Promise<LockedAttempt<T>> => {
      if (successorIsCurrent && !successorIsCurrent())
        return { kind: 'refused', error: inactiveLease() };
      const current = readAddressed();
      if (!lockPlan.keys.length && isInactive(current)) return { kind: 'replan' };
      const admission = await resolveExpiryAdmission(current);
      if (admission.kind !== 'admitted') return admission;
      if (expiryProbe) return { kind: 'replan' };
      if (
        attachesToSession &&
        current &&
        current.session.device.id !== lockPlan.deviceId &&
        !hasOuterLocks
      )
        return { kind: 'replan' };

      return await runAdmittedAttempt(current, task, successorIsCurrent);
    };

    const lockAndAdmit = async <T>(
      task: () => Promise<T>,
      observed: SessionRef | undefined,
      pinned: SessionRef | undefined,
      successorIsCurrent: (() => boolean) | undefined,
    ): Promise<LockedAttempt<T>> => {
      const expired = isInactive(pinned);
      const pending = settlementFor(pinned);
      if (pending || (expired && outerKeys.includes(sessionKey))) {
        const admission = await resolveExpiryAdmission(pinned, pending);
        return admission.kind === 'admitted' ? { kind: 'replan' } : admission;
      }
      const plan =
        expired || !attachesToSession
          ? { keys: expired ? [sessionKey] : [], deviceId: undefined }
          : resolveRequestExecutionLockPlan({
              req: scopedReq,
              sessionName,
              existingDeviceId: observed?.session.device.id,
              env: sessionStore.host.env,
            });
      const lockPlan = plan instanceof Promise ? await plan : plan;
      const openWait = beginOpenDeviceWait({
        req: scopedReq,
        budgetMs:
          openWaitBudgetMs === undefined ? undefined : Math.max(0, waitDeadline - Date.now()),
        sessionName,
        sessionStore,
        deviceId: lockPlan.deviceId,
      });
      if (openWait) await openWait.waitForDeviceOutsideLocks();
      if (settlementFor(pinned)) return { kind: 'replan' };
      requestExecutionLocks = createRequestExecutionLocks({
        locks: executionLocks,
        initialKeys: lockPlan.keys,
        scope: params.platformRequestScope,
      });
      const run = () => runLockPlan(lockPlan, task, successorIsCurrent, expired);
      return openWait
        ? await openWait.runWhenDeviceIsUnheld({
            acquireLocks: requestExecutionLocks.run,
            task: run,
          })
        : await requestExecutionLocks.run(run);
    };

    const scope: RequestExecutionScope = {
      host: params.host,
      req: scopedReq,
      command,
      sessionName,
      requestLogPath,
      runnerLogPath,
      retainDeviceExecutionLock: async (deviceId) =>
        await (requestExecutionLocks?.retainDevice(deviceId) ??
          scopedReq.internal?.retainDeviceExecutionLock?.(deviceId)),
      tryRunUnderSessionLock: async (ref, task) => {
        const key = sessionExecutionLockKey(sessionName);
        if (executionLocks.has(key)) return;
        await withRequestExecutionLockKeys(executionLocks, [key], async () => {
          if (sessionStore.resolveCurrent(ref)) await task();
        });
      },
      bindDevice: runtimeBindings.bindDevice,
      inspectFacts: runtimeBindings.inspectFacts,
      bindExactDevice: runtimeBindings.bindExactDevice,
      platformServices: { ...params.platformServices },
      dispatchLedger,
      throwIfCanceled: () => throwIfRequestCanceled(scopedReq.meta?.requestId),
      bindJournal(req, ref) {
        if (!ref) return req;
        const { journal } = coordinator.authorize(req, ref, () => true);
        if (command === 'events') {
          return { ...req, internal: { ...req.internal, readSessionEvents: journal.read } };
        }
        startJournal(journal);
        return req;
      },
      recordFinished,
      runAdmitted: async (task, admitted) => {
        throwIfRequestCanceled(scopedReq.meta?.requestId);
        const boundedStep =
          command !== 'batch' && command !== 'replay' && isBoundedCompositeRequest(scopedReq);
        const addressed = admitted ? admitted.ref : await readNestedAddress();
        assertRequestTenantAdmission(unscopedReq, addressed?.session);
        assertProviderLeaseRequestNamesSession(scopedReq, addressed?.session);
        let admissionCompleted = false;
        try {
          const existingRef = resolveRequestSessionRef(scopedReq, addressed);
          const session = existingRef?.session;
          const boundedResources = boundedStep
            ? await import('../core/composite-resource-admission.ts')
            : undefined;
          if (boundedResources) {
            await boundedResources.admitBoundedCompositeResourceRequest({
              req: scopedReq,
              session,
              validateSessionReopen: async (current) => {
                const { resolveExistingOpenRequest } =
                  await import('../sessions/session-lifecycle/internal/session-open.ts');
                const resolution = await resolveExistingOpenRequest({
                  req: scopedReq,
                  session: current,
                  platformServices: scope.platformServices,
                });
                if (resolution.type === 'response' && !resolution.response.ok) {
                  const { code, message, details } = resolution.response.error;
                  throw new AppError(code, message, details);
                }
              },
              closeWouldReleaseProviderLease: async () => {
                if (!session?.lease) return false;
                const facts =
                  scopedReq.flags?.shutdown === true
                    ? await scope.inspectFacts(session.device)
                    : undefined;
                return inspectSessionProviderReleaseOnClose({
                  shutdownRequested:
                    facts?.device.providerMode === 'provider-runtime' &&
                    facts.operations.shutdownTarget.available,
                  session,
                  leaseRegistry,
                  leaseLifecycleProvider: params.leaseLifecycleProvider,
                });
              },
              claimRecovery: {
                currentSessionExists: Boolean(session),
                resolveDevice: async () => {
                  const selected = await resolveBoundedClaimDevice(
                    prepareLockedRequestBinding({ req: scopedReq, existingRef }).req,
                    session,
                    params.host.env,
                    scope.platformServices,
                  );
                  await scopedReq.internal?.retainDeviceExecutionLock?.(selected.id);
                  return selected;
                },
                hasInMemorySessionOwner: (device) =>
                  sessionStore.findByDevice(device.id) !== undefined,
                session: sessionName,
                workspace: requestCwd(scopedReq, params.host),
                stateDir: sessionStore.resolveDaemonStateDir(),
                env: params.host.env,
                observeDeviceBoot: scope.platformServices.deviceBootObservation,
                claimConflictError: deviceClaimConflictError,
                coveredClaimIsOwnedByRequest: (claim) => {
                  const root = resolveCallerScopeRoot(scopedReq.meta?.cwd);
                  return !root || resolveCallerScopeRoot(claim.workspace) === root;
                },
              },
            });
          }
          throwIfRequestCanceled(scopedReq.meta?.requestId);
          scope.admittedRef = existingRef;
          scopedReq = admitLease(addressed, admitted?.assertSuccessorCurrent);
          scope.req = scopedReq;
          const admittedLease = scopedReq.internal?.admittedLease;
          if (admittedLease) await assertMacOsAppLeaseProcess(admittedLease);
          return await runAdmittedLeaseWork({
            assertCurrent: admitted?.assertSuccessorCurrent,
            leaseRegistry,
            req: scopedReq,
            task: async () => {
              admissionCompleted = true;
              return await task();
            },
          });
        } finally {
          // Stamp completion under the session lock so the idle reaper cannot overtake live work.
          if (
            admissionCompleted &&
            attachesToSession &&
            !isRequestCanceled(scopedReq.meta?.requestId)
          ) {
            sessionStore.noteSessionActivity(sessionName);
          }
        }
      },
      runLocked: async <T>(task: () => Promise<T>): Promise<T> => {
        let pinned = readsSessionLease ? preflightRef : undefined;
        let successorIsCurrent: (() => boolean) | undefined;
        for (;;) {
          throwIfRequestCanceled(scopedReq.meta?.requestId);
          const observed = readAddressed();
          if (readsSessionLease) pinned ??= observed;
          const attempt = await lockAndAdmit(task, observed, pinned, successorIsCurrent);
          switch (attempt.kind) {
            case 'admitted':
              return attempt.value;
            case 'refused':
              throw attempt.error;
            case 'replan':
              if (!settlementFor(pinned)) pinned = undefined;
              continue;
            case 'need-settlement':
              successorIsCurrent = await waitForSettlement(attempt);
              pinned = undefined;
          }
        }
      },
      // Claims outlive the bindings they guard: release only once no device
      // operation from this request can still run.
      [Symbol.asyncDispose]: disposeBindings,
    };
    requestScopeFinalizers.set(scope, (response) => {
      recordFinished(scopedReq, response);
      return response;
    });
    return scope;
  }
}

function createRequestDeviceAccess(params: {
  env: EnvMap;
  req: DaemonRequest;
  command: string;
  sessionName: string;
  dispatchLedger: RequestDispatchLedger;
  workspace: string;
  callerCwd: string | undefined;
  stateDir: string;
  deviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations>;
  platformRequestScope: PlatformRequestScope;
  daemonPolicy: DaemonPolicy | undefined;
  admitDevicePin: ((device: DeviceInfo) => void) | undefined;
  claimRecoveryGateway: ClaimRecoveryGatewayFactory;
  trackClaimRecoveryDisposal: (disposal: Promise<void>) => void;
  sessionStore: SessionStore;
}): {
  claimAdmission: DeviceClaimAdmission;
  runtimeBindings: RequestRuntimeBindings;
} {
  const { deviceRuntimeGateway, platformRequestScope, daemonPolicy } = params;
  const claimPolicy = resolveCommandDeviceClaimPolicy(params.command);
  const claimAdmission = createDeviceClaimAdmission({
    policy: claimPolicy,
    command: params.command,
    session: params.sessionName,
    workspace: params.workspace,
    callerCwd: params.callerCwd,
    resolveScopeRoot: resolveCallerScopeRoot,
    stateDir: params.stateDir,
    env: params.env,
    reconcileOrphanedDeviceClaim: createOwnerScopedDeviceClaimReconciler({
      scope: platformRequestScope,
      beforeGateway: async (claim) => {
        const { createBoundedClaimRecoveryBeforeGateway } =
          await import('../core/composite-resource-admission.ts');
        return createBoundedClaimRecoveryBeforeGateway(params.req)(claim);
      },
      composeGateway: params.claimRecoveryGateway,
      trackDisposal: params.trackClaimRecoveryDisposal,
    }),
  });
  return {
    claimAdmission,
    runtimeBindings: createRequestRuntimeBindings({
      gateway: deviceRuntimeGateway,
      scope: platformRequestScope,
      dispatchLedger: params.dispatchLedger,
      admitDeviceClaim: claimAdmission.admit,
      admitDevice:
        params.admitDevicePin || daemonPolicy || claimPolicy === 'require-owner'
          ? (device) => {
              params.admitDevicePin?.(device);
              if (daemonPolicy) {
                assertDaemonPolicyAdmitsDevice(daemonPolicy, device);
              }
              if (claimPolicy === 'require-owner' && !params.sessionStore.get(params.sessionName)) {
                const refusal = findSessionDeviceConflict({
                  req: params.req,
                  device,
                  sessionStore: params.sessionStore,
                  sessionName: params.sessionName,
                });
                if (refusal) {
                  throw new AppError(
                    refusal.error.code,
                    refusal.error.message,
                    refusal.error.details,
                  );
                }
              }
            }
          : undefined,
    }),
  };
}

function applyRequestCommandDefaults(req: DaemonRequest): DaemonRequest {
  const flags = { ...(req.flags ?? {}) };
  const changed = applyCommandDefaults(req.command, flags);
  if (!changed) return req;
  return {
    ...req,
    flags: flags as CommandFlags,
  };
}

function preparedSessionRef(
  ref: SessionRef | undefined,
  scope: RequestExecutionScope,
  sessionStore: SessionStore,
  canDetach: boolean,
): SessionRef | undefined {
  if (!ref) return undefined;
  scope.throwIfCanceled();
  if (canDetach) {
    if (!sessionStore.resolveCurrent(ref)) return undefined;
  } else {
    sessionStore.requireCurrent(ref);
  }
  return sessionStore.refresh(ref);
}

export async function prepareLockedRequestScope(params: {
  scope: RequestExecutionScope;
  sessionStore: SessionStore;
  trackDownloadableArtifact: output.TrackDownloadableArtifact;
}): Promise<LockedRequestScopeResult> {
  const { scope, sessionStore, trackDownloadableArtifact } = params;
  const logPath = scope.runnerLogPath;
  scope.throwIfCanceled();
  const ref = scope.admittedRef;
  if (scope.command === 'open' && ref) assertSameOpenOwner(scope.req, ref.session);
  const refreshHealth = scope.command !== 'events';
  const canDetach = refreshHealth && !shouldLockSessionExecution(scope.command);
  if (ref && canDetach) {
    await scope.tryRunUnderSessionLock(ref, async () => {
      await refreshRecordingHealth(sessionStore, ref, scope.platformServices);
    });
  } else if (ref && refreshHealth && scope.command !== 'batch' && scope.command !== 'replay') {
    // A composite's resource health is checked by its admitted steps; the outer read can invalidate a durable recording.
    await refreshRecordingHealth(sessionStore, ref, scope.platformServices);
  }
  const binding = prepareLockedRequestBinding({
    req: scope.req,
    existingRef: preparedSessionRef(ref, scope, sessionStore, canDetach),
  });
  const lockedReq = scope.bindJournal(binding.req, binding.existingRef);
  // `scope.sessionName` is the resolved store key, so `existingRef` carries the address every
  // recovery producer below must name — `existingRef.session.name` is only the public name.
  const existingRef = binding.existingRef;
  const existingSession = existingRef?.session;
  updateDiagnosticsScope(output.requestTraceDiagnostics(lockedReq, existingRef, sessionStore));
  const finalize = (handled: DaemonResponse): DaemonResponse => {
    const finalized = finalizeDaemonResponse(lockedReq, handled, trackDownloadableArtifact);
    scope.recordFinished(lockedReq, finalized);
    return finalized;
  };
  requestScopeFinalizers.set(scope, finalize);

  const recordingInvalidatedReason =
    existingSession?.screenRecording?.handle.inspect().invalidatedReason;
  if (recordingInvalidatedReason && shouldBlockForInvalidRecording(scope.command)) {
    return {
      type: 'response',
      response: {
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: recordingInvalidatedReason,
        },
      },
    };
  }

  if (existingRef && !lockedReq.meta?.lockPolicy && shouldValidateSessionSelector(scope.command)) {
    assertSessionSelectorMatches(existingRef, lockedReq.flags);
  }

  const contextFromFlags = (
    flags: CommandFlags | undefined,
    appBundleId?: string,
    traceLogPath?: string,
  ): DaemonCommandContext =>
    contextFromRequestFlags(logPath, flags, appBundleId, traceLogPath, lockedReq.meta);

  return {
    type: 'scope',
    scope: {
      req: lockedReq,
      sessionName: scope.sessionName,
      logPath,
      existingSession,
      existingRef,
      resolveSessionRef: (req, ref) => {
        const resolved = resolveRequestSessionRef(req, ref);
        return resolved?.lifetime === existingRef?.lifetime ? resolved : undefined;
      },
      retainDeviceExecutionLock: scope.retainDeviceExecutionLock,
      bindDevice: scope.bindDevice,
      platformServices: scope.platformServices,
      inspectFacts: scope.inspectFacts,
      bindExactDevice: scope.bindExactDevice,
      dispatchLedger: scope.dispatchLedger,
      throwIfCanceled: scope.throwIfCanceled,
      contextFromFlags,
      handlerContextFromFlags: (flags, appBundleId, traceLogPath) =>
        ({
          ...contextFromFlags(flags, appBundleId, traceLogPath),
          // Handlers may update surface during the request, so read the current session state.
          surface: existingRef ? sessionStore.resolveCurrent(existingRef)?.surface : undefined,
        }) satisfies DaemonCommandContext,
    },
  };
}

/** Final response/event construction runs only after request bindings dispose. */
export function finalizeRequestExecutionScope(
  scope: RequestExecutionScope,
  response: DaemonResponse,
): DaemonResponse {
  const finalize = requestScopeFinalizers.get(scope);
  requestScopeFinalizers.delete(scope);
  return finalize ? finalize(response) : response;
}

function contextFromRequestFlags(
  logPath: string,
  flags: CommandFlags | undefined,
  appBundleId?: string,
  traceLogPath?: string,
  meta?: DaemonRequest['meta'],
): DaemonCommandContext {
  const requestId = getDiagnosticsMeta().requestId;
  return {
    ...contextFromFlagsWithLog(logPath, flags, appBundleId, traceLogPath, requestId, meta),
    requestId,
  };
}

/** The idle reaper shares these locks so expiry cannot tear down an active request. */
export function leaseRegistrySessionExecutionLock(leaseRegistry: LeaseRegistry) {
  return createSessionExecutionLock(getLeaseRegistryExecutionLocks(leaseRegistry));
}

export function getLeaseRegistryExecutionLocks(
  leaseRegistry: LeaseRegistry,
): Map<string, Promise<unknown>> {
  let locks = leaseRegistryExecutionLocks.get(leaseRegistry);
  if (!locks) {
    locks = new Map();
    leaseRegistryExecutionLocks.set(leaseRegistry, locks);
  }
  return locks;
}
