import type {
  CloudArtifactsQuery,
  CloudArtifactsResult,
} from '@agent-device/contracts/observability';
import type { DeviceLease, LeaseLifecycleContext } from '@agent-device/contracts/device';
import { deviceFieldsFromPublicPlatform, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { unavailableCloudArtifactsResult } from './artifact-results.ts';
import {
  createCloudWebDriverCapabilities,
  buildCloudWebDriverBaseCapabilities,
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';
import { WebDriverClient, type WebDriverSession } from './webdriver-client.ts';
import { isWebDriverRequestTimeout } from './webdriver-transport.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';
import { snapshotBackendForPlatform } from './runtime-helpers.ts';
import { releaseOnFailure } from './webdriver-utils.ts';
import type {
  CloudWebDriverBaseSession,
  CloudWebDriverPreparedSession,
  CloudWebDriverRuntimeOptions,
} from './runtime.ts';
import type { Interactor } from '@agent-device/contracts/interactor-types';

export type WebDriverProviderSession = Readonly<{
  lease: DeviceLease;
  device: DeviceInfo;
  client: WebDriverClient;
  interactor: Interactor;
  prepared: CloudWebDriverPreparedSession;
  capabilities: CloudWebDriverProviderCapabilities;
  webDriverSessionId: string;
  providerSessionId: string;
}>;

type CloudWebDriverReleaseWarning = Readonly<{
  code: 'WEBDRIVER_SESSION_DELETE_FAILED' | 'PROVIDER_CLEANUP_FAILED';
  message: string;
}>;
type LeaseResult = Record<string, unknown> | undefined;

/**
 * What one lease has in this manager: the create the hub has not answered, the session that create
 * rented, or the disposal that is ending it. This is the only place a billed session is recorded, so
 * every route that can end one — release, shutdown, and the allocation still waiting for the create —
 * reads it here. Entries never leave this module, so their fields stay mutable.
 *
 * The entry in the map owns the lease's session, and it keeps owning it while it is being ended:
 * `taken` is set in the same synchronous step that starts the disposal, and the entry leaves the map
 * only once that disposal settles. So a lease is never between owners while its session may be live —
 * an allocation that arrives mid-release is refused, a second release joins the disposal in flight, and
 * shutdown awaits it instead of starting another.
 *
 * An allocation reads its own refusal from the `taken` of the entry it joined, so the reason names the
 * teardown that actually happened rather than whatever state the manager is in by the time the create
 * answers, and it carries what that disposal came to.
 */
type WebDriverLeaseEntry = {
  lease: DeviceLease;
  /** Settles with the session the hub rented, or rejects when the create billed nothing. */
  creation: Promise<WebDriverProviderSession>;
  /** What the create rented. Missing while the create is still running, and never set when it failed. */
  session: WebDriverProviderSession | undefined;
  /** Which route took this lease from its allocation, and the one disposal that owns its session. */
  taken: WebDriverLeaseTake | undefined;
};

/**
 * Whichever route took a lease away from its allocation, and the single disposal of what that entry
 * stood for. `settled` is what that disposal reported and stays missing while it is still running, so a
 * caller can tell a session that is gone from one whose outcome it cannot see yet.
 */
type WebDriverLeaseTake = {
  by: 'release' | 'shutdown';
  /** The session being ended, known as soon as the create named it. */
  providerSessionId: string | undefined;
  disposal: Promise<WebDriverDisposalOutcome>;
  settled: WebDriverDisposalOutcome | undefined;
};

/**
 * What ending one lease's session came to. `cleanup` answers whether a billed session is certainly
 * gone: `confirmed` once the hub ended it, `uncertain` when ending it failed, and `none` when the
 * create rented nothing.
 */
type WebDriverDisposalOutcome = Readonly<{
  cleanup: 'confirmed' | 'uncertain' | 'none';
  session: WebDriverProviderSession | undefined;
  warnings: CloudWebDriverReleaseWarning[];
  /** What the provider's own cleanup reported, for the release envelope. */
  cleanupPayload?: Record<string, unknown>;
  artifacts?: CloudArtifactsResult;
}>;

/** The fields of one warning, keyed as `details.cleanupWarnings` carries them on a refusal. */
function warningMessagesByCode(warnings: CloudWebDriverReleaseWarning[]): Record<string, string> {
  return Object.fromEntries(warnings.map((warning) => [warning.code, warning.message]));
}

/**
 * Owns WebDriver session lifecycle and stale-owner retention. Deployment decisions stay in the
 * sibling runtime-deployment module so neither concern widens the public runtime façade.
 */
export class WebDriverSessionManager {
  private readonly entriesByLeaseId = new Map<string, WebDriverLeaseEntry>();
  private readonly ownedDeviceIds = new Set<string>();
  private readonly releasedProviderSessionIdsByLeaseId = new Map<string, string>();
  private readonly options: CloudWebDriverRuntimeOptions;
  /** Whether this manager has shut down; it can then hold nothing, so it must create nothing. */
  private shutDown = false;

  constructor(options: CloudWebDriverRuntimeOptions) {
    this.options = options;
  }

  ownsDevice(device: DeviceInfo): boolean {
    return this.ownedDeviceIds.has(device.id);
  }

  findSessionForDevice(device: DeviceInfo): WebDriverProviderSession | undefined {
    return this.liveSessions().find((session) => session.device.id === device.id);
  }

  findSessionForLease(leaseId: string): WebDriverProviderSession | undefined {
    return this.liveSession(this.entriesByLeaseId.get(leaseId));
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return this.findSessionForDevice(device)?.interactor;
  }

  heartbeat(lease: DeviceLease): Record<string, unknown> | undefined {
    if (lease.leaseProvider !== this.options.provider) return undefined;
    if (!this.liveSession(this.entriesByLeaseId.get(lease.leaseId))) return undefined;
    return { provider: this.options.provider };
  }

  async allocate(lease: DeviceLease, req?: LeaseLifecycleContext): Promise<LeaseResult> {
    if (lease.leaseProvider !== this.options.provider) return undefined;
    // Every allocation is refused for the flags this provider reads no profile field for, before it
    // joins or publishes anything: a call answers for its own flags and never inherits another call's,
    // and one that cannot be honoured bills nothing.
    await this.rejectRefusedProfileFields(req);
    // The lease's entry is published here, in the same synchronous step as the lookup above: a second
    // allocation of this lease joins the create rather than renting a second billed session, and a
    // release or shutdown that arrives while the create runs finds the session it is renting.
    let entry = this.entriesByLeaseId.get(lease.leaseId);
    if (entry === undefined) {
      if (this.shutDown) throw allocationRefusedAfterShutdown(this.options.provider, lease);
      entry = this.beginAllocation(lease, req);
    }
    // A lease whose disposal is running belongs to the route that is ending it, so this call rented
    // nothing and is refused for that disposal rather than for a session of its own.
    if (entry.taken) throw refusalForTeardownInProgress(this.options.provider, lease, entry.taken);
    // Reported without awaiting anything after the lookup, so the session is live at the moment the
    // caller is told about it: a release or a shutdown cannot end it inside this call.
    if (entry.session) return { provider: this.options.provider };
    const session = await entry.creation;
    // The session this call rented is its own only while nobody took the lease. Otherwise a release or
    // shutdown ended what the create rented, and this caller is refused rather than handed a session id
    // nothing will release.
    if (entry.taken) throw await this.refusalForTakenSession(lease, entry.taken);
    return this.allocationResult(session);
  }

  async release(lease: DeviceLease): Promise<LeaseResult> {
    if (lease.leaseProvider !== this.options.provider) return undefined;
    const entry = this.entriesByLeaseId.get(lease.leaseId);
    // Nothing holds the lease: it was never allocated here, or its release finished and gave the lease
    // back. A release that arrives while another one disposes joins that disposal.
    if (entry === undefined) return undefined;
    const outcome = await this.takeForRelease(entry);
    // A create that failed billed nothing, and gave back what its preparation had already rented.
    if (outcome.session === undefined) return undefined;
    return {
      provider: this.options.provider,
      providerSessionId: outcome.session.providerSessionId,
      ...outcome.cleanupPayload,
      ...(outcome.warnings.length > 0 ? { warnings: outcome.warnings } : {}),
      ...(outcome.artifacts ? { cloudArtifacts: outcome.artifacts } : {}),
    };
  }

  async listCloudArtifacts(query: CloudArtifactsQuery): Promise<CloudArtifactsResult | undefined> {
    if (query.provider !== this.options.provider) return undefined;
    const session = this.findSessionForLease(query.leaseId ?? '');
    if (session) return await this.listActiveCloudArtifacts(session, query.providerSessionId);
    return await this.listReleasedCloudArtifacts(query);
  }

  private async listActiveCloudArtifacts(
    session: WebDriverProviderSession,
    providerSessionId: string | undefined,
  ): Promise<CloudArtifactsResult | undefined> {
    if (providerSessionId && providerSessionId !== session.providerSessionId) return undefined;
    return await this.safeListArtifacts(session);
  }

  private async listReleasedCloudArtifacts(
    query: CloudArtifactsQuery,
  ): Promise<CloudArtifactsResult | undefined> {
    const providerSessionId = this.releasedProviderSessionIdsByLeaseId.get(query.leaseId ?? '');
    if (!providerSessionId || !this.options.listArtifacts) return undefined;
    if (query.providerSessionId && query.providerSessionId !== providerSessionId) return undefined;
    return await this.options.listArtifacts({
      provider: this.options.provider,
      providerSessionId,
    });
  }

  /**
   * Ends every session this manager holds or is on its way to holding, and says so when it could not.
   * Each lease is taken, or joined, in one synchronous step, so a create that answers afterwards is
   * disposed by the one disposal of that entry and by no other route, and a release already running is
   * awaited rather than raced.
   */
  async shutdown(): Promise<void> {
    this.shutDown = true;
    // Snapshot before anything is awaited: `allocate` publishes an entry only when none exists and
    // refuses once this manager is shut down, and nothing between that flag and this loop awaits.
    const disposals = [...this.entriesByLeaseId.values()].map(
      async (entry) => await this.takeForShutdown(entry),
    );
    const outcomes = await Promise.all(disposals);
    this.ownedDeviceIds.clear();
    // A session the provider would not give back is still billing, and this process will not stop it.
    // The plugin's close is where an operator learns what a daemon close left running, so the session
    // and the provider's reason travel on the error rather than being dropped.
    const unended = outcomes.filter((outcome) => outcome.cleanup === 'uncertain');
    if (unended.length > 0) throw shutdownLeftSessionsRunning(this.options.provider, unended);
  }

  /**
   * Publishes the entry one lease's create is standing on before that create can answer, so a duplicate
   * allocation joins it and a release or shutdown that arrives mid-create has somewhere to find the
   * session the create will rent. The entry records that session when the hub answers, and leaves the
   * map when the create failed and billed nothing.
   */
  private beginAllocation(lease: DeviceLease, req: LeaseLifecycleContext | undefined) {
    let rentSession!: (session: WebDriverProviderSession) => void;
    let refuseSession!: (error: unknown) => void;
    const creation = new Promise<WebDriverProviderSession>((rent, refuse) => {
      rentSession = rent;
      refuseSession = refuse;
    });
    const entry: WebDriverLeaseEntry = { lease, creation, session: undefined, taken: undefined };
    this.entriesByLeaseId.set(lease.leaseId, entry);
    // Started after the publication above, so the create's answer can never arrive without an entry
    // beside it. Whichever route took the entry in the meantime disposes the session this answers.
    void this.createSessionForLease(lease, req).then(
      (session) => {
        entry.session = session;
        this.ownedDeviceIds.add(session.device.id);
        rentSession(session);
      },
      (error: unknown) => {
        // The create billed nothing and gave back what its preparation rented, so the lease is free
        // again as soon as nobody is left to dispose anything for it.
        if (entry.taken === undefined && this.entriesByLeaseId.get(lease.leaseId) === entry) {
          this.entriesByLeaseId.delete(lease.leaseId);
        }
        refuseSession(error);
      },
    );
    return entry;
  }

  /**
   * Prepares the lease and rents the hub session, and hands back the session this manager can dispose.
   * The allocation's own flags were refused before it got here, so nothing that cannot be honoured ever
   * asks the hub to bill a device.
   */
  private async createSessionForLease(
    lease: DeviceLease,
    req: LeaseLifecycleContext | undefined,
  ): Promise<WebDriverProviderSession> {
    const prepared = await this.prepareSession(lease, req);
    const client = new WebDriverClient({
      clientVersion: this.options.clientVersion,
      endpoint: prepared.endpoint,
      auth: prepared.auth,
      headers: prepared.headers,
      requestPolicy: this.options.requestPolicy,
    });
    const session = await this.createSessionWithPreparedCleanup(client, prepared, lease, req);
    const device = this.deviceForLease(lease, prepared);
    const capabilities = createCloudWebDriverCapabilities({
      provider: this.options.provider,
      platform: prepared.platform,
      overrides: this.options.capabilityOverrides,
    });
    return Object.freeze({
      lease,
      device,
      client,
      prepared,
      capabilities,
      webDriverSessionId: session.sessionId,
      providerSessionId: prepared.providerSessionId ?? session.sessionId,
      interactor: createWebDriverInteractor({
        client,
        backend: snapshotBackendForPlatform(prepared.platform),
        capabilities,
        targetId: device.id,
      }),
    });
  }

  /** Takes the lease for `release`, or joins the disposal already ending it. */
  private async takeForRelease(entry: WebDriverLeaseEntry): Promise<WebDriverDisposalOutcome> {
    return await this.take(entry, 'release');
  }

  /** Takes the lease for `shutdown`, or joins the disposal already ending it. */
  private async takeForShutdown(entry: WebDriverLeaseEntry): Promise<WebDriverDisposalOutcome> {
    return await this.take(entry, 'shutdown');
  }

  /**
   * Hands one lease's session to the one route that may end it. The take and the disposal it starts are
   * recorded before this step returns, so no route can reach the lease in between and find it free, and
   * the entry leaves the map only once that disposal has settled.
   */
  private take(entry: WebDriverLeaseEntry, by: 'release' | 'shutdown') {
    const taken = entry.taken;
    if (taken) return taken.disposal;
    let reportDisposal!: (outcome: WebDriverDisposalOutcome) => void;
    const disposal = new Promise<WebDriverDisposalOutcome>((report) => {
      reportDisposal = report;
    });
    entry.taken = {
      by,
      providerSessionId: entry.session?.providerSessionId,
      disposal,
      settled: undefined,
    };
    void this.disposeTakenEntry(entry).then((outcome) => {
      const take = entry.taken!;
      take.settled = outcome;
      take.providerSessionId = outcome.session?.providerSessionId;
      // Whatever the create rented is now ended, or was never rented, so this entry owns nothing and the
      // lease is free again.
      if (this.entriesByLeaseId.get(entry.lease.leaseId) === entry) {
        this.entriesByLeaseId.delete(entry.lease.leaseId);
      }
      reportDisposal(outcome);
    });
    return disposal;
  }

  /**
   * Ends what one taken entry stands for: the session its create rented, once that create answers, or
   * nothing when the create billed nothing. This is the only place a session is ended, and one entry is
   * taken by exactly one route, so a session is ended once.
   */
  private async disposeTakenEntry(entry: WebDriverLeaseEntry): Promise<WebDriverDisposalOutcome> {
    const session = entry.session ?? (await entry.creation.catch(() => undefined));
    entry.session = session;
    if (session === undefined) return { cleanup: 'none', session: undefined, warnings: [] };
    this.releasedProviderSessionIdsByLeaseId.set(entry.lease.leaseId, session.providerSessionId);
    const warnings: CloudWebDriverReleaseWarning[] = [];
    let cleanupPayload: Record<string, unknown> | undefined;
    try {
      await session.client.deleteSession();
    } catch (error) {
      warnings.push({
        code: 'WEBDRIVER_SESSION_DELETE_FAILED',
        message: errorMessage(error),
      });
    }
    try {
      cleanupPayload = await session.prepared.cleanup?.();
    } catch (error) {
      warnings.push({ code: 'PROVIDER_CLEANUP_FAILED', message: errorMessage(error) });
    }
    const artifacts = await this.safeListArtifacts(session);
    // Only a hub that answered can say the session is gone. A delete the provider refused leaves the
    // session billing, and this manager has no way left to learn otherwise.
    const cleanup = warnings.length > 0 ? 'uncertain' : 'confirmed';
    return { cleanup, session, warnings, cleanupPayload, artifacts };
  }

  /**
   * The refusal for the allocation whose session a teardown took. The disposal's own answer is the only
   * thing that can confirm a billed session is gone, so the refused caller waits for it rather than
   * claiming an end it cannot see.
   */
  private async refusalForTakenSession(
    lease: DeviceLease,
    take: WebDriverLeaseTake,
  ): Promise<AppError> {
    const outcome = await take.disposal;
    return refusalForTeardown(this.options.provider, lease, take.by, {
      providerSessionId: outcome.session?.providerSessionId,
      cleanup: outcome.cleanup,
      warnings: outcome.warnings,
    });
  }

  private allocationResult(session: WebDriverProviderSession): Record<string, unknown> {
    return {
      provider: this.options.provider,
      deviceId: session.device.id,
      sessionId: session.webDriverSessionId,
      providerSessionId: session.providerSessionId,
      capabilities: session.capabilities,
      ...session.prepared.providerData,
    };
  }

  private async createSessionWithPreparedCleanup(
    client: WebDriverClient,
    prepared: CloudWebDriverPreparedSession,
    lease: DeviceLease,
    req: LeaseLifecycleContext | undefined,
  ): Promise<WebDriverSession> {
    try {
      return await client.createSession(prepared.webdriverCapabilities, {
        deadline: req?.deadline,
      });
    } catch (error) {
      const failure = isWebDriverRequestTimeout(error)
        ? sessionCreateTimeoutError(error, this.options.provider, lease, prepared)
        : error;
      await releaseOnFailure(failure, () => prepared.cleanup?.());
      throw failure;
    }
  }

  /**
   * Refuses the flags this provider reads no profile field for, so a field that would be ignored is
   * reported instead of dropped. The module is loaded on first use to keep the package entry's own
   * closure unchanged.
   */
  private async rejectRefusedProfileFields(req: LeaseLifecycleContext | undefined): Promise<void> {
    const { rejectRefusedProviderProfileFields } =
      await import('@agent-device/contracts/provider-profile-fields');
    rejectRefusedProviderProfileFields(req?.flags, this.options.profileFields);
  }

  private async prepareSession(
    lease: DeviceLease,
    req: LeaseLifecycleContext | undefined,
  ): Promise<CloudWebDriverPreparedSession> {
    const base = this.baseSessionForLease(lease);
    return this.options.prepareSession
      ? await this.options.prepareSession({ lease, req, base })
      : base;
  }

  private baseSessionForLease(lease: DeviceLease): CloudWebDriverBaseSession {
    const configured =
      typeof this.options.webdriverCapabilities === 'function'
        ? this.options.webdriverCapabilities(lease)
        : (this.options.webdriverCapabilities ?? {});
    return {
      provider: this.options.provider,
      endpoint: this.options.endpoint,
      platform: this.options.platform,
      deviceName: this.options.deviceName,
      auth: this.options.auth,
      headers: this.options.headers,
      webdriverCapabilities: buildCloudWebDriverBaseCapabilities(
        this.options.platform,
        this.options.deviceName,
        configured,
      ),
    };
  }

  private deviceForLease(lease: DeviceLease, prepared: CloudWebDriverPreparedSession): DeviceInfo {
    return {
      ...deviceFieldsFromPublicPlatform(prepared.platform),
      ...(prepared.platform === 'ios' ? { appleOs: 'ios' as const } : {}),
      id:
        prepared.deviceId ??
        this.options.deviceId?.(lease) ??
        `${this.options.provider}:${prepared.platform}:${lease.leaseId}`,
      name: prepared.deviceName,
      kind: 'device',
      target: 'mobile',
      booted: true,
    };
  }

  /** The session a lease holds and can still drive: rented, and not on its way to being ended. */
  private liveSession(entry: WebDriverLeaseEntry | undefined) {
    return entry?.taken === undefined ? entry?.session : undefined;
  }

  private liveSessions(): WebDriverProviderSession[] {
    return [...this.entriesByLeaseId.values()].flatMap((entry) => {
      const session = this.liveSession(entry);
      return session ? [session] : [];
    });
  }

  private async safeListArtifacts(
    session: WebDriverProviderSession,
  ): Promise<CloudArtifactsResult | undefined> {
    const listArtifacts = session.prepared.listArtifacts ?? this.options.listArtifacts;
    if (!listArtifacts) return undefined;
    try {
      return await listArtifacts({
        provider: this.options.provider,
        lease: session.lease,
        device: session.device,
        webDriverSessionId: session.webDriverSessionId,
        providerSessionId: session.providerSessionId,
      });
    } catch (error) {
      return unavailableCloudArtifactsResult({
        provider: this.options.provider,
        providerSessionId: session.providerSessionId,
        error,
      });
    }
  }
}

/**
 * The transport gave up on `POST /session`; the provider may still finish it,
 * and nothing here can learn that session's id — so the error names the lease
 * the capabilities were labelled with, which the provider dashboard can be
 * searched by.
 */
function sessionCreateTimeoutError(
  timeout: AppError,
  provider: string,
  lease: DeviceLease,
  prepared: CloudWebDriverPreparedSession,
): AppError {
  const timeoutMs = timeout.details?.timeoutMs;
  return new AppError(
    'COMMAND_FAILED',
    `${provider} did not create the WebDriver session within ${String(timeoutMs)}ms.`,
    {
      reason: 'provider_session_create_timeout',
      provider,
      leaseId: lease.leaseId,
      runId: lease.runId,
      timeoutMs,
      ...(prepared.providerSessionId ? { providerSessionId: prepared.providerSessionId } : {}),
      hint: `${provider} may still finish creating the session after agent-device stopped waiting, and that session would keep billing until the provider reaps it. Before retrying, check ${provider} for a running session created for lease ${lease.leaseId} (run ${lease.runId}) and stop it.`,
    },
    timeout,
  );
}

/** What a route that ended one lease's session can say about it, `pending` while it still cannot. */
type WebDriverTeardownReport = Readonly<{
  providerSessionId: string | undefined;
  cleanup: WebDriverDisposalOutcome['cleanup'] | 'pending';
  warnings: CloudWebDriverReleaseWarning[];
}>;

/**
 * The refusal an allocation gets for the teardown that ended the session it stood for: which route ended
 * it, and whether that end is confirmed or known to have failed.
 */
function refusalForTeardown(
  provider: string,
  lease: DeviceLease,
  by: 'release' | 'shutdown',
  report: WebDriverTeardownReport,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${provider} ended the WebDriver session allocated for lease ${lease.leaseId} before the allocation returned.`,
    {
      reason:
        by === 'release'
          ? 'provider_session_released_during_allocation'
          : 'provider_session_shutdown_during_allocation',
      provider,
      leaseId: lease.leaseId,
      runId: lease.runId,
      ...(report.providerSessionId ? { providerSessionId: report.providerSessionId } : {}),
      cleanup: report.cleanup,
      ...(report.warnings.length > 0
        ? { cleanupWarnings: warningMessagesByCode(report.warnings) }
        : {}),
      hint: teardownHint(provider, report.cleanup),
    },
  );
}

/**
 * The refusal for an allocation that arrived while a release was still ending the lease's previous
 * session. It rented nothing, so it is told the lease is being ended rather than that a session of its
 * own died, and it may not allocate again until that disposal finishes.
 */
function refusalForTeardownInProgress(
  provider: string,
  lease: DeviceLease,
  take: WebDriverLeaseTake,
): AppError {
  if (take.by === 'shutdown') {
    return refusalForTeardown(provider, lease, 'shutdown', {
      providerSessionId: take.providerSessionId ?? take.settled?.session?.providerSessionId,
      cleanup: take.settled?.cleanup ?? 'pending',
      warnings: take.settled?.warnings ?? [],
    });
  }
  const cleanup = take.settled?.cleanup ?? 'pending';
  return new AppError(
    // ADR 0010: the lease slot is held by the release in flight, so this is contention, and the caller
    // can expect the same allocate to succeed once that release finishes.
    'DEVICE_IN_USE',
    `${provider} is releasing lease ${lease.leaseId} and allocated no WebDriver session for it.`,
    {
      reason: 'provider_session_release_in_progress',
      provider,
      leaseId: lease.leaseId,
      runId: lease.runId,
      ...(take.providerSessionId ? { providerSessionId: take.providerSessionId } : {}),
      cleanup,
      hint:
        cleanup === 'uncertain'
          ? `agent-device could not stop the previous session of this lease. Check ${provider} for it before allocating again.`
          : 'Wait for this lease to finish releasing, then allocate it again.',
    },
  );
}

/**
 * This manager was already shut down when the allocation arrived, so it created nothing and owes nothing.
 */
function allocationRefusedAfterShutdown(provider: string, lease: DeviceLease): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${provider} is shut down and created no WebDriver session for lease ${lease.leaseId}.`,
    {
      reason: 'provider_session_shutdown_during_allocation',
      provider,
      leaseId: lease.leaseId,
      runId: lease.runId,
      cleanup: 'none',
      hint: 'Start the daemon again to allocate a provider session.',
    },
  );
}

/**
 * What the refused allocation should do next: nothing once the hub confirmed the session is gone, and a
 * manual stop on the provider when the hub did not confirm it.
 */
function teardownHint(
  provider: string,
  cleanup: WebDriverDisposalOutcome['cleanup'] | 'pending',
): string {
  if (cleanup === 'uncertain') {
    return `${provider} did not confirm it stopped the session this allocation created, and that session may keep billing. Check ${provider} for it before allocating the lease again.`;
  }
  if (cleanup === 'pending') {
    return `agent-device is still stopping the session this allocation created. Wait for that release to finish before allocating the lease again.`;
  }
  if (cleanup === 'none') {
    return 'Nothing was billed for this allocation. Allocate the lease again.';
  }
  return 'Allocate the lease again; agent-device stopped the session this allocation created.';
}

/**
 * Sessions this manager could not end at close. A daemon close reports what it left running, so the
 * error names every session still billing and why it is still there, and the create-retry policy stays
 * untouched: nothing here deletes or creates a session again on its own.
 */
function shutdownLeftSessionsRunning(
  provider: string,
  outcomes: WebDriverDisposalOutcome[],
): AppError {
  const providerSessionIds = outcomes.map((outcome) => outcome.session?.providerSessionId);
  return new AppError(
    'COMMAND_FAILED',
    `${provider} left ${String(outcomes.length)} WebDriver session(s) running after shutdown: ${providerSessionIds.join(', ')}.`,
    {
      reason: 'provider_session_cleanup_incomplete',
      provider,
      providerSessionIds,
      cleanup: 'uncertain',
      cleanupWarnings: warningMessagesByCode(outcomes.flatMap((outcome) => outcome.warnings)),
      hint: `${provider} did not stop these sessions and they keep billing. Stop the session ids above on ${provider}.`,
    },
  );
}
