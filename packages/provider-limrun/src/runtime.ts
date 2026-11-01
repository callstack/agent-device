import Limrun from '@limrun/api';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleProvider,
  LeaseLifecycleContext,
  ProviderAppCatalogHandler,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
  ProviderExpiredLeaseRecovery,
  ProviderPortReverseOptions,
} from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import {
  configureLimrunAndroidPortReverse,
  createLimrunAndroidInteractor,
  createLimrunAndroidSession,
  installLimrunAndroidApp,
  type LimrunAndroidSession,
} from './android.ts';
import {
  attachedLimrunInstanceId,
  buildLimrunDevice,
  LIMRUN_PROVIDER,
  parseLimrunDeviceId,
  platformForLimrunLeaseBackend,
  type LimrunPlatform,
} from './device.ts';
import { createLimrunIosInteractor, createLimrunIosSession, installLimrunIosApp } from './ios.ts';
import { createLimrunDeviceSession, type LimrunDeviceSession } from './device-session.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { LimrunAppLogDescriptor } from './app-log-descriptor.ts';
import type { LimrunAppLogReader } from './app-log-runtime.ts';
import {
  deleteLimrunInstance,
  LIMRUN_CLIENT_ID,
  limrunUserAgent,
  requireLimrunOrgClient,
} from './client-options.ts';
import { resolveLimrunRuntimeInstance } from './runtime-instance.ts';
import type { LimrunRequestOperationDrain } from './request-cancellation.ts';
import type { LimrunAppAsset } from './app-catalog.ts';
import type { LimrunInstanceAccess } from './instance-access.ts';
import type {
  CloudArtifactProvider,
  CloudArtifactsResult,
} from '@agent-device/contracts/observability';
import type {
  LimrunAppAlias,
  LimrunCreateOutcome,
  LimrunDeleteResult,
  LimrunDisposalOutcome,
  LimrunLeaseOwner,
  LimrunRuntimeSession,
  LimrunTeardownRoute,
} from './lease-ownership.ts';
import type { LimrunCaptureLifecycle } from './capture-lifecycle.ts';
import type { LimrunDisposalHost } from './lease-release.ts';

const KEEP_ALIVE_INTERVAL_MS = 30_000;

export type LimrunRuntimeOptions = {
  /** Organization API key. It creates and deletes instances for platforms without `instances`. */
  apiKey?: string;
  region?: string;
  /** Pings each leased instance every 30 s so Limrun's inactivity timeout does not end idle sessions. */
  keepAlive?: boolean;
  runtimeInstance?: string;
  instances?: LimrunInstanceAccess;
  /** Where `--provider-network-logs` writes each lease's HAR file. Without it the capture is unavailable. */
  networkHarDir?: string;
};

export type LimrunRuntime = ProviderDeviceRuntime & {
  recoverExpiredLease: ProviderExpiredLeaseRecovery;
  getDeviceSession(device: DeviceInfo): LimrunDeviceSession | undefined;
};

export type LimrunRuntimeRegistration = Readonly<{
  runtime: LimrunRuntime;
  platformModule: PlatformRuntimeProviderModule;
}>;

export function createLimrunRuntime(
  options: LimrunRuntimeOptions,
  dependencies: LimrunRuntimeDependencies,
  mode: Readonly<{ includePlatformModule: true }>,
): LimrunRuntimeRegistration;
export function createLimrunRuntime(
  options: LimrunRuntimeOptions,
  dependencies: LimrunRuntimeDependencies,
): LimrunRuntime;
export function createLimrunRuntime(
  options: LimrunRuntimeOptions,
  dependencies: LimrunRuntimeDependencies,
  mode?: Readonly<{ includePlatformModule: true }>,
): LimrunRuntime | LimrunRuntimeRegistration {
  const runtime = new LimrunRuntimeImplementation(options, dependencies);
  if (!mode?.includePlatformModule) return runtime;
  const owner = providerRuntimeOwner(LIMRUN_PROVIDER, resolveLimrunRuntimeInstance(options));
  if (owner.kind !== 'provider-runtime') throw new TypeError('Invalid Limrun runtime owner');
  return Object.freeze({
    runtime,
    platformModule: Object.freeze({
      owner,
      loadRuntime: async (host: PlatformRuntimeHost) =>
        await loadLimrunPlatformRuntime(runtime, owner.instance, host),
    }),
  });
}

class LimrunRuntimeImplementation implements ProviderDeviceRuntime {
  private readonly limrun: Limrun | undefined;
  /**
   * A lease has an owner from the step it is allocated until the one disposal of it confirms. Allocate,
   * join, release, recovery, shutdown and every reader of a live session go through this one map, so an
   * in-flight create is never invisible to the route that has to end what it rents.
   */
  private readonly leases = new Map<string, LimrunLeaseOwner>();
  /**
   * What each lease's network capture goes through, including the records a release settled. Absent until a
   * lease asks for a capture, which is what keeps the capture's module out of a runtime that captures nothing:
   * the lifecycle is only ever reached through `await import('./capture-lifecycle.ts')` in `captures()`, and
   * this declaration stays a type for exactly that reason.
   */
  private capturesInstance?: LimrunCaptureLifecycle;
  /** Whether this runtime has shut down; it then holds nothing, so it must create nothing. */
  private shutDown = false;
  private readonly options: LimrunRuntimeOptions;
  private readonly dependencies: LimrunRuntimeDependencies;
  readonly provider = LIMRUN_PROVIDER;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease, context) => await this.allocate(lease, context),
    release: async (lease) => await this.release(lease),
  };

  readonly appCatalog: ProviderAppCatalogHandler = async (query, signal) => {
    const { assertLimrunUploadedAppAccess, listLimrunAppAssets } = await import('./app-catalog.ts');
    assertLimrunUploadedAppAccess(query.publicNetworkOnly);
    const limrun = this.orgClient(
      'Listing uploaded apps',
      'Run open <bundle-or-package-id> first; apps then lists the apps installed on the instance.',
    );
    return (await listLimrunAppAssets(limrun, query.platform, signal)).map((asset) => asset.name);
  };

  readonly recoverExpiredLease: ProviderExpiredLeaseRecovery = async (lease) => {
    if (lease.leaseProvider !== this.provider || !platformForLimrunLeaseBackend(lease.backend)) {
      throw new AppError('UNSUPPORTED_OPERATION', 'Limrun cannot recover this expired lease.', {
        leaseId: lease.leaseId,
        leaseProvider: lease.leaseProvider,
        leaseBackend: lease.backend,
      });
    }
    await this.release(lease);
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider || !request.leaseId) return null;
    const session = this.liveSessionForLease(request.leaseId);
    if (!session) return null;
    if (request.platform && request.platform !== session.platform) return [];
    return [session.device];
  };

  constructor(options: LimrunRuntimeOptions, dependencies: LimrunRuntimeDependencies) {
    if (!options.apiKey && !options.instances?.ios && !options.instances?.android) {
      throw new TypeError('Limrun runtime requires an apiKey or instance access');
    }
    this.options = options;
    this.dependencies = dependencies;
    this.limrun = options.apiKey
      ? new Limrun({
          apiKey: options.apiKey,
          userAgent: limrunUserAgent(dependencies.clientVersion),
        })
      : undefined;
  }

  /**
   * The capture lifecycle, made the first time a lease asks for a capture. The records a release settled live
   * there, so an artifacts read for a lease this runtime no longer holds goes through the same instance that
   * settled them, and a runtime that never captures anything never evaluates that module.
   */
  private async captures(): Promise<LimrunCaptureLifecycle> {
    if (this.capturesInstance === undefined) {
      const { LimrunCaptureLifecycle } = await import('./capture-lifecycle.ts');
      // Two allocations can be inside this load at once, and the settled records have to be one lifecycle's.
      this.capturesInstance ??= new LimrunCaptureLifecycle({
        harDir: this.options.networkHarDir,
        liveSessionOf: (owner) => this.liveSession(owner),
        heldOwners: () => this.leases.values(),
      });
    }
    return this.capturesInstance;
  }

  ownsDevice(device: DeviceInfo): boolean {
    return parseLimrunDeviceId(device.id) !== undefined;
  }

  hasLiveSession(device: DeviceInfo): boolean {
    return this.getSessionForDevice(device) !== undefined;
  }

  getInteractor(device: DeviceInfo, _runner?: RunnerContext): Interactor | undefined {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    return session.platform === 'ios'
      ? createLimrunIosInteractor(session)
      : createLimrunAndroidInteractor(session);
  }

  getDeviceSession(device: DeviceInfo): LimrunDeviceSession | undefined {
    const session = this.getSessionForDevice(device);
    return session ? createLimrunDeviceSession(session) : undefined;
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
    signal?: AbortSignal,
    operationDrain?: LimrunRequestOperationDrain,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.installInstallablePath(
      device,
      appPath,
      {
        ...options,
        appIdentifierHint: options?.appIdentifierHint ?? app,
        packageNameHint: options?.packageNameHint ?? app,
      },
      signal,
      operationDrain,
    );
  }

  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
    signal?: AbortSignal,
    operationDrain?: LimrunRequestOperationDrain,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    const limrun = this.orgClient('Uploading an app');
    return session.platform === 'ios'
      ? await installLimrunIosApp(limrun, session, installablePath, options, signal, operationDrain)
      : await installLimrunAndroidApp(
          limrun,
          session,
          installablePath,
          options,
          signal,
          operationDrain,
        );
  }

  async configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    const session = this.requireAndroidPortReverseSession(options.leaseId);
    if (!session) return undefined;
    await configureLimrunAndroidPortReverse(session, options);
    return portReverseResult(options);
  }

  /**
   * Ends every instance this runtime holds or is on its way to holding, and says so when it could not.
   * Each lease is taken, or joined, in one synchronous step, so a create that answers afterwards is
   * disposed by the one disposal of that lease and by no other route, and a release already running is
   * awaited rather than raced.
   */
  async shutdown(): Promise<void> {
    this.shutDown = true;
    // Snapshot into a binding before anything is awaited: `allocate` refuses once this flag is set and
    // publishes an owner only where none exists, and nothing between the flag and this snapshot awaits. So
    // no create can start here, and every create already running has an owner in this snapshot to take.
    const held = [...this.leases.values()];
    const outcomes = await Promise.all(
      held.map(async (owner) => await this.take(owner, 'shutdown')),
    );
    // An instance Limrun would not give back is still billed, and this process will not stop it. The
    // plugin's close is where an operator learns what a daemon close left running, so the instance and
    // the provider's refusal travel on the error rather than being dropped.
    const unended = outcomes.filter((outcome) => outcome.cleanup === 'uncertain');
    if (unended.length > 0) {
      const { cleanupLeftInstancesRunning } = await import('./lease-release.ts');
      throw cleanupLeftInstancesRunning(unended);
    }
  }

  private async allocate(
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider) return undefined;
    const platform = platformForLimrunLeaseBackend(lease.backend);
    if (!platform) return undefined;
    // Published without awaiting anything, so a lease is never unowned while its allocation is at its first
    // await: a release or a shutdown arriving there finds this owner and takes it, and the create that owner
    // stands on answers the caller's own profile flags before it bills anything.
    let owner = this.leases.get(lease.leaseId);
    if (owner === undefined) {
      // Nothing between this lookup and the publication below awaits, so two allocations of one lease can
      // never both pass it, and this runtime can be shut down only before or after this step.
      if (this.shutDown) throw allocationRefusedAfterShutdown(lease);
      owner = this.beginAllocation(lease, platform, context);
    } else {
      // A lease this runtime already holds, so this call answers for flags of its own, and settles them before
      // it awaits anything else — including a create that is already running. Joining one is no way to be
      // handed a session this caller was never entitled to; a new lease is validated as the first step of its
      // own create instead, which is what keeps this publication free of any await.
      await this.rejectRefusedProfileFields(context);
    }
    await this.joinCreation(owner, context);
    // A repeat allocation can ask for the capture, or retry one that could not start. A lease a teardown has
    // already taken starts nothing: `captures.start` reads the owner's own live session, and what this lease
    // has is that teardown's to end.
    if (context?.flags?.providerNetworkLogs === true && owner.capture?.phase !== 'capturing') {
      const captures = await this.captures();
      await captures.start(owner, context.flags.providerNetworkHosts);
    }
    // A release or shutdown that took the lease while this call waited owns the instance the create made, and
    // answers for it. This caller is refused for that teardown, with what it came to, rather than being handed
    // an instance nothing will release for it. The refusal waits for the teardown to answer, so this caller
    // never reports before the instance it was promised is gone.
    const taken = owner.state;
    if (taken.phase === 'releasing') {
      const outcome = await taken.disposal;
      const { allocationRefusedForTake } = await import('./lease-release.ts');
      throw allocationRefusedForTake(lease, taken.by, outcome);
    }
    const session = this.requireLiveSession(owner);
    return { limrunInstanceId: session.instanceId, device: session.device };
  }

  /**
   * Brings one owner to the point its live session answers, and refuses this caller only for what it asked
   * for itself.
   */
  private async joinCreation(
    owner: LimrunLeaseOwner,
    context?: LeaseLifecycleContext,
  ): Promise<void> {
    if (owner.state.phase !== 'allocating') return;
    const create = await this.creationFor(owner, context);
    if (create === undefined) return;
    if (create.status === 'ready') {
      this.goLive(owner, create.session, create.appAlias);
      return;
    }
    if (create.status === 'refused_caller') throw create.error;
    // A create that failed has no release coming for it, so this call is the only route left to end an
    // instance it made before failing. What it came to outranks why the create did not finish: an instance
    // Limrun is still billing is the caller's problem first.
    const outcome = await this.settleFailedCreate(owner);
    if (outcome?.cleanup === 'uncertain') {
      const { createLeftInstanceRunning } = await import('./lease-release.ts');
      throw createLeftInstanceRunning(owner.lease, outcome, create.error);
    }
    throw create.error;
  }

  /**
   * The create one caller is entitled to: the one its lease's owner stands on, unless that create refused the
   * caller that started it for a flag this provider reads no field for. That refusal billed nothing, so it is
   * that caller's answer and not this lease's: a caller whose own flags this provider does read asks for the
   * create the refusal foreclosed and makes it the lease's creation, on the owner the lease already has. Any
   * later joiner of the same refusal follows that create rather than renting a second instance.
   */
  private async creationFor(
    owner: LimrunLeaseOwner,
    context?: LeaseLifecycleContext,
  ): Promise<LimrunCreateOutcome | undefined> {
    for (;;) {
      const started = owner.creation;
      const create = await started;
      if (create.status !== 'refused_caller') return create;
      // This caller's own flags were answered for before it got here, so the refusal below is another
      // caller's. Another joiner of it may have replaced it while this caller was being answered: join that.
      if (owner.creation !== started) continue;
      // A teardown took the lease in the meantime, so what this lease has is that route's to end.
      if (owner.state.phase !== 'allocating') return undefined;
      const retried = this.createForLease(owner, context);
      owner.creation = retried;
      // Observed from the moment it is published, like the original creation: the owner's type promises a
      // creation that cannot reach the process unobserved, and this keeps that promise by construction, not
      // only by the fact that `createForLease` reports its failures as outcomes.
      void retried.catch(() => undefined);
      return await retried;
    }
  }

  /** The profile flags this provider reads nothing for, refused for a lease this runtime already holds. */
  private async rejectRefusedProfileFields(context?: LeaseLifecycleContext): Promise<void> {
    // Loaded here rather than eagerly so this package entry's declared closure stays unchanged. The create
    // of a new allocation refuses the same flags as its first step, inside the owner it published.
    const { rejectRefusedLimrunProfileFields } = await import('./session-allocation.ts');
    rejectRefusedLimrunProfileFields(context);
  }

  /**
   * Publishes the owner one allocation's create is standing on, in the same step that starts the create
   * and before it can answer, so a duplicate allocation joins that create instead of making a second
   * instance, and a release or shutdown arriving mid-create has somewhere to find the instance that create
   * is on its way to making. The owner records that instance the moment Limrun names it, so whichever route
   * takes the lease has what it has to end.
   */
  private beginAllocation(
    lease: DeviceLease,
    platform: LimrunPlatform,
    context?: LeaseLifecycleContext,
  ): LimrunLeaseOwner {
    let report!: (create: LimrunCreateOutcome) => void;
    const creation = new Promise<LimrunCreateOutcome>((settled) => {
      report = settled;
    });
    const owner: LimrunLeaseOwner = {
      lease,
      platform,
      creation,
      state: { phase: 'allocating' },
      rentedInstanceId: undefined,
      session: undefined,
      localRelease: undefined,
      keepAlive: undefined,
      capture: undefined,
      appAlias: undefined,
      deletedInstanceId: undefined,
      pendingDelete: undefined,
    };
    this.leases.set(lease.leaseId, owner);
    // The create is started after the publication above, so its answer can never arrive without an owner
    // beside it. Whichever route takes the lease in the meantime ends what this answer names.
    void this.createForLease(owner, context).then(report);
    return owner;
  }

  /**
   * Attaches or makes this lease's instance and answers with the whole outcome rather than with a promise
   * that resolves or rejects: a refused caller still has to say whether anything was left running, and the
   * owner is where an instance this create rented gets recorded. Nothing here ends an instance, and nothing
   * retries a create: a create whose answer was lost may have made an instance anyway, and that instance is
   * reported and ended, never replaced by a second one.
   */
  private async createForLease(
    owner: LimrunLeaseOwner,
    context?: LeaseLifecycleContext,
  ): Promise<LimrunCreateOutcome> {
    try {
      const {
        allocateLimrunAndroidSession,
        allocateLimrunIosSession,
        rejectRefusedLimrunProfileFields,
        resolvePreinstalledAppId,
        resolveRequestedLimrunAppAsset,
      } = await import('./session-allocation.ts');
      // The first step of the create, so an allocation that published its owner before it could await
      // anything still bills nothing for flags this provider reads no field for. That refusal belongs to the
      // caller that carried the flag: it says nothing about the lease, which is why the owner's creation
      // carries it as `refused_caller` rather than as a failed create.
      try {
        rejectRefusedLimrunProfileFields(context);
      } catch (error) {
        return { status: 'refused_caller', error };
      }
      const platform = owner.platform;
      // Attach first, and only ask for the organization client if there is nothing to attach: an attached
      // instance needs no API key, and is not created with an app asset of ours.
      const attached = await this.attachSession(platform, owner.lease);
      if (attached) {
        owner.session = attached;
        return { status: 'ready', session: attached, appAlias: undefined };
      }
      const limrun = this.orgClient('Creating an instance');
      const requestedAsset = await resolveRequestedLimrunAppAsset(limrun, platform, context);
      const params = this.sessionAllocationParams(limrun, owner.lease, requestedAsset);
      const rent = (instanceId: string): void => {
        owner.rentedInstanceId = instanceId;
      };
      // The session is recorded in the step that answers for it, so every later step of this allocation
      // fails with its handles still owned: the instance client and the host ADB endpoint are released by
      // whoever ends this lease, whether or not the allocation ever answered.
      const session =
        platform === 'ios'
          ? await allocateLimrunIosSession(params, rent)
          : await allocateLimrunAndroidSession(params, rent);
      owner.session = session;
      const appAlias: LimrunAppAlias | undefined = requestedAsset && {
        assetName: requestedAsset.name,
        installedAppId: await resolvePreinstalledAppId(session, requestedAsset),
      };
      return { status: 'ready', session, appAlias };
    } catch (error) {
      return { status: 'failed', error };
    }
  }

  /**
   * Puts the instance one create made, and the app alias that came with it, onto its owner. Another
   * allocation that joined the same create can get here first, and a route that took the lease while the
   * create ran owns the instance instead — either way this owner is already where it belongs, and nothing
   * is published for a lease that no longer has an allocation.
   */
  private goLive(
    owner: LimrunLeaseOwner,
    session: LimrunRuntimeSession,
    appAlias: LimrunAppAlias | undefined,
  ): void {
    if (owner.state.phase !== 'allocating') return;
    owner.appAlias = appAlias;
    owner.state = { phase: 'live', session };
    if (this.options.keepAlive) this.startKeepAlive(owner, session);
  }

  /**
   * Closes an owner whose create made nothing, and ends the instance one that made an instance before it
   * failed. A create that failed has no release coming for it — its caller is being refused — so this is
   * the route that ends what it left running, through the same take every other teardown goes through.
   * The outcome is reported to that caller, which is the only one left to hear it.
   */
  private async settleFailedCreate(
    owner: LimrunLeaseOwner,
  ): Promise<LimrunDisposalOutcome | undefined> {
    const state = owner.state;
    if (state.phase === 'allocating') return await this.take(owner, 'create');
    // Another route took the lease while this call waited, and its disposal owns what the create made.
    return state.phase === 'releasing' ? await state.disposal : undefined;
  }

  /**
   * Hands one lease's resources to the one route that may end them, or joins the disposal already ending
   * them. The take and the disposal it starts are recorded before this step returns, so no route can reach
   * the lease in between and find it free, and the owner leaves the map only once that disposal confirmed.
   * A disposal that could not confirm keeps the owner here, so the next release, recovery or shutdown
   * retries the delete rather than reporting an instance Limrun may still be billing.
   */
  private take(owner: LimrunLeaseOwner, by: LimrunTeardownRoute): Promise<LimrunDisposalOutcome> {
    const taken = owner.state;
    const settled = taken.phase === 'releasing' ? taken.settled : undefined;
    if (taken.phase === 'releasing' && !(settled?.cleanup === 'uncertain')) return taken.disposal;
    let reportDisposal!: (outcome: LimrunDisposalOutcome) => void;
    const disposal = new Promise<LimrunDisposalOutcome>((settledOutcome) => {
      reportDisposal = settledOutcome;
    });
    owner.state = {
      phase: 'releasing',
      by,
      instanceId:
        this.liveSession(owner)?.instanceId ?? owner.rentedInstanceId ?? settled?.instanceId,
      disposal,
      settled: undefined,
    };
    const report = (outcome: LimrunDisposalOutcome): void => {
      const state = owner.state;
      if (state.phase === 'releasing') {
        state.settled = outcome;
        state.instanceId = outcome.instanceId ?? state.instanceId;
        // Whatever the create made is now ended, or was never made, so this owner holds nothing and the
        // lease is free again. An unconfirmed delete keeps the owner so its outcome can be retried.
        if (outcome.cleanup !== 'uncertain') this.closeOwner(owner);
      }
      reportDisposal(outcome);
    };
    // `disposeOwner` reports the failures it can name, so the rejection branch is only for what it could not
    // report at all. The disposal still answers, because a caller may be waiting on this lease's instance.
    void this.disposeOwner(owner).then(report, (error: unknown) => {
      report({
        cleanup: 'uncertain',
        instanceId: owner.rentedInstanceId,
        failure: errorMessage(error),
        cause: error,
        capture: undefined,
      });
    });
    return disposal;
  }

  /**
   * Hands one taken owner to the module that ends what it stands for. The disposal may ask only two things of
   * this runtime — delete one instance and end one lease's capture — so it never reaches back into the routes
   * that allocate and read one, and the lease is still given back by the take that started this disposal.
   */
  private async disposeOwner(owner: LimrunLeaseOwner): Promise<LimrunDisposalOutcome> {
    const { disposeLimrunLeaseOwner } = await import('./lease-release.ts');
    return await disposeLimrunLeaseOwner(this.disposalHost, owner);
  }

  private readonly disposalHost: LimrunDisposalHost = {
    deleteInstance: async (platform, instanceId) =>
      await this.deleteCreatedInstance(platform, instanceId),
    endCapture: async (owner) => await this.capturesInstance?.end(owner),
  };

  /** One instance delete. `undefined` is Limrun's confirmation that the instance is gone. */
  private async deleteCreatedInstance(
    platform: LimrunPlatform,
    instanceId: string,
  ): Promise<LimrunDeleteResult> {
    const limrun = this.orgClient('Deleting an instance');
    return await deleteLimrunInstance(limrun, platform, instanceId);
  }

  /** Removes an owner once it holds nothing, and only while it is still the map's owner for that lease. */
  private closeOwner(owner: LimrunLeaseOwner): void {
    if (this.leases.get(owner.lease.leaseId) === owner) this.leases.delete(owner.lease.leaseId);
  }

  private startKeepAlive(owner: LimrunLeaseOwner, session: LimrunRuntimeSession): void {
    const timer = setInterval(() => {
      try {
        session.client.keepAlive();
      } catch {
        // A dead connection surfaces on the next real command.
      }
    }, KEEP_ALIVE_INTERVAL_MS);
    timer.unref();
    owner.keepAlive = timer;
  }

  readonly cloudArtifacts: CloudArtifactProvider = {
    listCloudArtifacts: async (query) => await this.listCloudArtifacts(query.leaseId),
  };

  /**
   * What `artifacts` answers for one lease: its capture written now while the lease is held, and the
   * record a release settled after the lease is gone. A runtime that never started a capture has no
   * lifecycle to ask, so nothing is loaded for it.
   */
  private async listCloudArtifacts(
    leaseId: string | undefined,
  ): Promise<CloudArtifactsResult | undefined> {
    if (leaseId === undefined) return undefined;
    const captures = this.capturesInstance;
    if (captures === undefined) return undefined;
    const { networkArtifacts } = await import('./network-har.ts');
    const capture = await captures.list(leaseId, this.leases.get(leaseId)?.capture);
    return capture && networkArtifacts(capture);
  }

  private async attachSession(
    platform: LimrunPlatform,
    lease: DeviceLease,
  ): Promise<LimrunRuntimeSession | undefined> {
    const { ios, android } = this.options.instances ?? {};
    const target = (apiUrl: string) => {
      const instanceId = attachedLimrunInstanceId(apiUrl);
      const device = buildLimrunDevice(platform, lease, instanceId);
      return { lease, instanceId, ownership: 'attached' as const, device };
    };
    if (platform === 'android') {
      return (
        android &&
        (await createLimrunAndroidSession(
          { ...target(android.apiUrl), ...android },
          this.dependencies,
        ))
      );
    }
    return (
      ios && (await createLimrunIosSession({ ...target(ios.apiUrl), ...ios }, this.dependencies))
    );
  }

  private sessionAllocationParams(limrun: Limrun, lease: DeviceLease, app?: LimrunAppAsset) {
    return {
      limrun,
      lease,
      metadata: this.buildInstanceMetadata(lease),
      region: this.options.region,
      app,
      dependencies: this.dependencies,
    };
  }

  private buildInstanceMetadata(lease: DeviceLease) {
    return {
      displayName: `agent-device-${lease.tenantId}-${lease.runId}`,
      labels: {
        tenantId: lease.tenantId,
        runId: lease.runId,
        leaseId: lease.leaseId,
        provider: lease.leaseProvider ?? LIMRUN_PROVIDER,
        source: LIMRUN_CLIENT_ID,
      },
    };
  }

  private async release(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    // The take happens in this step, before anything is loaded: the release owns the lease from here, and no
    // await in between can let the allocation still waiting on its create answer ahead of it.
    const owner = this.leases.get(lease.leaseId);
    const disposal = owner === undefined ? undefined : this.take(owner, 'release');
    const { releaseLimrunLease } = await import('./lease-release.ts');
    return await releaseLimrunLease(this.limrun, lease, disposal);
  }

  private orgClient(operation: string, hint?: string): Limrun {
    return requireLimrunOrgClient(this.limrun, operation, hint);
  }

  /** The live session of one owner: what its create made, and only while the lease is held. */
  private liveSession(owner: LimrunLeaseOwner | undefined): LimrunRuntimeSession | undefined {
    return owner?.state.phase === 'live' ? owner.state.session : undefined;
  }

  /** The live session of one owner, for a route that has already refused every other phase. */
  private requireLiveSession(owner: LimrunLeaseOwner): LimrunRuntimeSession {
    const session = this.liveSession(owner);
    if (session === undefined) {
      throw new AppError(
        'COMMAND_FAILED',
        `Limrun lease '${owner.lease.leaseId}' has no live session`,
        { reason: 'limrun_lease_not_live' },
      );
    }
    return session;
  }

  private liveSessionForLease(leaseId: string): LimrunRuntimeSession | undefined {
    return this.liveSession(this.leases.get(leaseId));
  }

  private getSessionForDevice(device: DeviceInfo): LimrunRuntimeSession | undefined {
    const parsed = parseLimrunDeviceId(device.id);
    if (!parsed) return undefined;
    const session = this.liveSessionForLease(parsed.leaseId);
    return session?.platform === parsed.platform ? session : undefined;
  }

  resolveAppReference(device: DeviceInfo, app: string): string {
    const parsed = parseLimrunDeviceId(device.id);
    if (!parsed) return app;
    const alias = this.leases.get(parsed.leaseId)?.appAlias;
    return alias?.assetName === app ? alias.installedAppId : app;
  }

  currentAppLogReader(device: DeviceInfo): LimrunAppLogReader | undefined {
    const session = this.getSessionForDevice(device);
    if (!session) return undefined;
    const publicSession = createLimrunDeviceSession(session);
    return {
      platform: session.platform,
      leaseId: session.lease.leaseId,
      instanceId: session.instanceId,
      ownership: session.ownership,
      readLogs: async (appBundleId, lineLimit) =>
        publicSession.platform === 'ios'
          ? await publicSession.readLogs(appBundleId, lineLimit)
          : await publicSession.readLogs(lineLimit),
      [Symbol.asyncDispose]: async () => undefined,
    };
  }

  async reconnectAppLogReader(descriptor: LimrunAppLogDescriptor, signal?: AbortSignal) {
    const { reconnectLimrunAppLogReader } = await import('./app-log-reconnect.ts');
    return await reconnectLimrunAppLogReader({
      limrun: this.limrun,
      instances: this.options.instances,
      descriptor,
      dependencies: this.dependencies,
      signal,
    });
  }

  private requireAndroidPortReverseSession(leaseId: string): LimrunAndroidSession | undefined {
    const session = this.liveSessionForLease(leaseId);
    if (!session || session.platform === 'android') return session;
    throw unsupported(
      'port reverse',
      'Direct Limrun iOS sessions cannot reach local host ports; use a bridge public URL.',
    );
  }
}

async function loadLimrunPlatformRuntime(
  runtime: LimrunRuntimeImplementation,
  runtimeInstance: string,
  host: PlatformRuntimeHost,
): Promise<PlatformRuntimeOwner> {
  const { createLimrunPlatformRuntimeOwner } = await import('./app-log-runtime.ts');
  return createLimrunPlatformRuntimeOwner({
    host,
    runtimeInstance,
    ownsDevice: (device) => runtime.ownsDevice(device),
    hasLiveSession: (device) => runtime.hasLiveSession(device),
    getInteractor: (device, runner) => runtime.getInteractor(device, runner),
    getDeviceSession: (device) => runtime.getDeviceSession(device),
    resolveAppReference: (device, app) => runtime.resolveAppReference(device, app),
    openCurrent: async (device) => runtime.currentAppLogReader(device),
    reconnect: async (descriptor, signal) =>
      await runtime.reconnectAppLogReader(descriptor, signal),
    listApps: async (device, filter, signal) => {
      signal.throwIfAborted();
      const session = runtime.getDeviceSession(device);
      if (!session) {
        throw new AppError('DEVICE_NOT_FOUND', 'Limrun app inventory session is unavailable', {
          deviceId: device.id,
        });
      }
      return (await session.listApps(filter)).map((app) => ({
        id: app.id,
        name: app.name ?? app.id,
      }));
    },
    getAppState: async (device, signal) => {
      signal.throwIfAborted();
      const session = runtime.getDeviceSession(device);
      if (session?.platform !== 'android') {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Limrun Android appstate requires an active provider session',
        );
      }
      const state = await session.getForegroundApp(signal);
      signal.throwIfAborted();
      return { package: state?.appId, activity: state?.activity };
    },
    deployApp: async (device, input, signal, operationDrain) =>
      await runtime.installApp(
        device,
        input.app,
        input.appPath,
        {
          relaunch: input.replaceExisting,
          appIdentifierHint: input.app,
          packageNameHint: input.app,
        },
        signal,
        operationDrain,
      ),
    deployMaterializedApp: async (device, input, signal, operationDrain) =>
      await runtime.installInstallablePath(
        device,
        input.artifact.installablePath,
        {
          appIdentifierHint: input.artifact.bundleId,
          packageNameHint: input.artifact.packageName,
        },
        signal,
        operationDrain,
      ),
    configurePortReverse: async (options) => await runtime.configurePortReverse(options),
  });
}

function portReverseResult(options: ProviderPortReverseOptions): Record<string, unknown> {
  return {
    leaseId: options.leaseId,
    devicePort: options.devicePort,
    hostPort: options.hostPort,
    name: options.name,
  };
}

function unsupported(command: string, message: string): never {
  throw new AppError('UNSUPPORTED_OPERATION', message, { command });
}

/** A lease cannot be allocated into a runtime that has been told to end every instance it holds. */
function allocationRefusedAfterShutdown(lease: DeviceLease): never {
  throw new AppError(
    'SESSION_NOT_FOUND',
    `Cannot allocate Limrun lease '${lease.leaseId}': this runtime is shut down`,
    {
      reason: 'limrun_runtime_shut_down',
      hint: 'Start the daemon again to allocate a Limrun lease.',
    },
  );
}
