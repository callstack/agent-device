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
type CloudWebDriverCloseResult = Readonly<{
  cleanup?: Record<string, unknown>;
  warnings: CloudWebDriverReleaseWarning[];
}>;
type LeaseResult = Record<string, unknown> | undefined;

/**
 * What one lease has in this manager: the create the hub has not answered, or the session that create
 * produced. This is the only place a billed session is recorded, so every route that can end one —
 * release, shutdown, and the allocation still waiting for the create — reads it here.
 *
 * Whoever holds an entry may dispose its session, and only one caller can hold one: an entry leaves
 * the map in a single synchronous step.
 */
type WebDriverLeaseEntry = WebDriverAllocatingEntry | WebDriverReadyEntry;
type WebDriverAllocatingEntry = Readonly<{
  status: 'allocating';
  /** Settles with the session the hub rented, or rejects when the create failed and owed nothing. */
  creation: Promise<WebDriverProviderSession>;
}>;
type WebDriverReadyEntry = Readonly<{
  status: 'ready';
  session: WebDriverProviderSession;
}>;

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
    return this.readySessions().find((session) => session.device.id === device.id);
  }

  findSessionForLease(leaseId: string): WebDriverProviderSession | undefined {
    return this.readySession(this.entriesByLeaseId.get(leaseId));
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return this.findSessionForDevice(device)?.interactor;
  }

  heartbeat(lease: DeviceLease): Record<string, unknown> | undefined {
    if (lease.leaseProvider !== this.options.provider) return undefined;
    if (!this.readySession(this.entriesByLeaseId.get(lease.leaseId))) return undefined;
    return { provider: this.options.provider };
  }

  async allocate(lease: DeviceLease, req?: LeaseLifecycleContext): Promise<LeaseResult> {
    if (lease.leaseProvider !== this.options.provider) return undefined;
    // The lease's entry is published here, before the first `await`: a second allocation of this lease
    // joins the create rather than renting a second billed session, and a release or shutdown that
    // arrives while the create runs finds the session it is renting.
    const existing = this.entriesByLeaseId.get(lease.leaseId);
    if (existing === undefined && this.shutDown) {
      throw allocationRefusedAfterShutdown(this.options.provider, lease.leaseId);
    }
    const entry = existing ?? this.beginAllocation(lease, req);
    if (entry.status === 'ready') {
      // A repeat allocation of a live lease carries flags of its own, and is refused for the ones no
      // profile field of this provider reads.
      await this.rejectRefusedProfileFields(req);
      return this.heartbeat(lease);
    }
    const session = await entry.creation;
    // The caller that started the create is refused for its own flags inside it, before anything is
    // billed; a caller that joined one is refused here, for the flags it carried with it.
    await this.rejectRefusedProfileFields(req);
    // The lease is still this call's only while the map holds the session it rented. Otherwise release
    // or shutdown took the entry while the create was running and disposed what it rented, so this
    // caller is refused rather than handed a session id nothing will release.
    if (this.readySession(this.entriesByLeaseId.get(lease.leaseId)) !== session) {
      if (this.shutDown) {
        throw allocationRefusedAfterShutdown(this.options.provider, lease.leaseId, true);
      }
      throw allocationRefusedByRelease(this.options.provider, lease);
    }
    return this.allocationResult(session);
  }

  async release(lease: DeviceLease): Promise<LeaseResult> {
    if (lease.leaseProvider !== this.options.provider) return undefined;
    // Taken synchronously, so a second release of the same lease cannot also dispose its session.
    const entry = this.entriesByLeaseId.get(lease.leaseId);
    if (!entry) return undefined;
    this.entriesByLeaseId.delete(lease.leaseId);
    const session = await this.disposableSession(entry);
    // A create that failed billed nothing and has already given back what its preparation rented.
    if (!session) return undefined;
    this.releasedProviderSessionIdsByLeaseId.set(lease.leaseId, session.providerSessionId);
    const close = await this.closeSession(session);
    const artifacts = await this.safeListArtifacts(session);
    return {
      provider: this.options.provider,
      providerSessionId: session.providerSessionId,
      ...close.cleanup,
      ...(close.warnings.length > 0 ? { warnings: close.warnings } : {}),
      ...(artifacts ? { cloudArtifacts: artifacts } : {}),
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
   * Ends every session this manager holds or is on its way to holding. Each entry is taken out of the
   * map before anything is awaited, so a create that answers afterwards is disposed here and by no
   * one else. A create that fails owes nothing: it has already given back what its preparation rented.
   */
  async shutdown(): Promise<void> {
    this.shutDown = true;
    // Snapshot and clear in one synchronous step: `allocate` refuses once the flag is set and nothing
    // between that flag and this clear awaits, so no entry can be added while these are disposed.
    const entries = [...this.entriesByLeaseId.values()];
    this.entriesByLeaseId.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        const session = await this.disposableSession(entry);
        if (session) await this.closeSession(session);
      }),
    );
    this.ownedDeviceIds.clear();
  }

  /**
   * Publishes the entry one lease's create is standing on before that create can answer, so a
   * duplicate allocation joins it and a release or shutdown that arrives mid-create has somewhere to
   * find the session the create will rent. The entry becomes the lease's ready session when the hub
   * answers, and is withdrawn when the create failed and billed nothing.
   */
  private beginAllocation(
    lease: DeviceLease,
    req: LeaseLifecycleContext | undefined,
  ): WebDriverAllocatingEntry {
    let rentSession!: (session: WebDriverProviderSession) => void;
    let refuseSession!: (error: unknown) => void;
    const creation = new Promise<WebDriverProviderSession>((rent, refuse) => {
      rentSession = rent;
      refuseSession = refuse;
    });
    const entry: WebDriverAllocatingEntry = Object.freeze({ status: 'allocating', creation });
    this.entriesByLeaseId.set(lease.leaseId, entry);
    // Started after the publication above, so the create's answer can never arrive without an entry
    // beside it. Whichever route took the entry in the meantime disposes the session this answers.
    void this.createSessionForLease(lease, req).then(
      (session) => {
        if (this.entriesByLeaseId.get(lease.leaseId) === entry) {
          this.entriesByLeaseId.set(lease.leaseId, { status: 'ready', session });
          this.ownedDeviceIds.add(session.device.id);
        }
        rentSession(session);
      },
      (error: unknown) => {
        if (this.entriesByLeaseId.get(lease.leaseId) === entry) {
          this.entriesByLeaseId.delete(lease.leaseId);
        }
        refuseSession(error);
      },
    );
    return entry;
  }

  /**
   * Prepares the lease, rents the hub session, and hands back the session this manager can dispose.
   * Flags no profile field of this provider reads are refused here, before the hub is asked for
   * anything: an allocation that cannot be honoured must not bill a device to find out.
   */
  private async createSessionForLease(
    lease: DeviceLease,
    req: LeaseLifecycleContext | undefined,
  ): Promise<WebDriverProviderSession> {
    await this.rejectRefusedProfileFields(req);
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

  /**
   * The session an entry stands for, once its create has answered, or `undefined` when it stands for
   * none because the create billed nothing. The create's failure is the answer of the allocation that
   * started it, so a release or shutdown that gets here first takes no error from it.
   */
  private async disposableSession(
    entry: WebDriverLeaseEntry,
  ): Promise<WebDriverProviderSession | undefined> {
    if (entry.status === 'ready') return entry.session;
    return await entry.creation.catch(() => undefined);
  }

  private readySession(entry: WebDriverLeaseEntry | undefined) {
    return entry?.status === 'ready' ? entry.session : undefined;
  }

  private readySessions(): WebDriverProviderSession[] {
    return [...this.entriesByLeaseId.values()].flatMap((entry) =>
      entry.status === 'ready' ? [entry.session] : [],
    );
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

  private async closeSession(
    session: WebDriverProviderSession,
  ): Promise<CloudWebDriverCloseResult> {
    const warnings: CloudWebDriverReleaseWarning[] = [];
    let cleanup: Record<string, unknown> | undefined;
    try {
      await session.client.deleteSession();
    } catch (error) {
      warnings.push({
        code: 'WEBDRIVER_SESSION_DELETE_FAILED',
        message: errorMessage(error),
      });
    }
    try {
      cleanup = await session.prepared.cleanup?.();
    } catch (error) {
      warnings.push({ code: 'PROVIDER_CLEANUP_FAILED', message: errorMessage(error) });
    }
    return { cleanup, warnings };
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

/**
 * A release took the lease's entry while its create was still running and disposed the session that
 * create rented. The caller is refused so it cannot drive a session agent-device has already ended.
 */
function allocationRefusedByRelease(provider: string, lease: DeviceLease): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${provider} released lease ${lease.leaseId} while it was creating the WebDriver session.`,
    {
      reason: 'provider_session_released_during_allocation',
      provider,
      leaseId: lease.leaseId,
      runId: lease.runId,
      hint: 'Allocate the lease again; agent-device already stopped the session this allocation created.',
    },
  );
}

/**
 * Either this manager was already shut down when the allocation arrived, or it shut down while the
 * create was running and disposed what it rented. Either way no session survives, so nothing here has
 * to be stopped by hand.
 */
function allocationRefusedAfterShutdown(
  provider: string,
  leaseId: string,
  disposedSession = false,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `${provider} is shut down and created no WebDriver session for lease ${leaseId}.`,
    {
      reason: 'provider_session_shutdown_during_allocation',
      provider,
      leaseId,
      disposedSession,
      hint: disposedSession
        ? 'Nothing to clean up: agent-device stopped the session it was creating.'
        : 'Start the daemon again to allocate a provider session.',
    },
  );
}
