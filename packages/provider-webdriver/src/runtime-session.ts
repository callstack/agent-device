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
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';
import { WebDriverClient, type WebDriverSession } from './webdriver-client.ts';
import { isWebDriverRequestTimeout } from './webdriver-transport.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';
import { snapshotBackendForPlatform } from './runtime-helpers.ts';
import { releaseOnFailure } from './webdriver-utils.ts';
import type {
  CloudWebDriverBaseSession,
  CloudWebDriverPlatform,
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
 * Owns WebDriver session lifecycle and stale-owner retention. Deployment decisions stay in the
 * sibling runtime-deployment module so neither concern widens the public runtime façade.
 */
export class WebDriverSessionManager {
  private readonly sessionsByLeaseId = new Map<string, WebDriverProviderSession>();
  private readonly ownedDeviceIds = new Set<string>();
  private readonly releasedProviderSessionIdsByLeaseId = new Map<string, string>();
  private readonly options: CloudWebDriverRuntimeOptions;

  constructor(options: CloudWebDriverRuntimeOptions) {
    this.options = options;
  }

  ownsDevice(device: DeviceInfo): boolean {
    return this.ownedDeviceIds.has(device.id);
  }

  findSessionForDevice(device: DeviceInfo): WebDriverProviderSession | undefined {
    return [...this.sessionsByLeaseId.values()].find((session) => session.device.id === device.id);
  }

  findSessionForLease(leaseId: string): WebDriverProviderSession | undefined {
    return this.sessionsByLeaseId.get(leaseId);
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return this.findSessionForDevice(device)?.interactor;
  }

  heartbeat(lease: DeviceLease): Record<string, unknown> | undefined {
    if (lease.leaseProvider !== this.options.provider) return undefined;
    if (!this.sessionsByLeaseId.has(lease.leaseId)) return undefined;
    return { provider: this.options.provider };
  }

  async allocate(lease: DeviceLease, req?: LeaseLifecycleContext): Promise<LeaseResult> {
    if (lease.leaseProvider !== this.options.provider) return undefined;
    if (this.sessionsByLeaseId.has(lease.leaseId)) return this.heartbeat(lease);
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
    const providerSessionId = prepared.providerSessionId ?? session.sessionId;
    const capabilities = createCloudWebDriverCapabilities({
      provider: this.options.provider,
      platform: prepared.platform,
      overrides: this.options.capabilityOverrides,
    });
    this.sessionsByLeaseId.set(
      lease.leaseId,
      Object.freeze({
        lease,
        device,
        client,
        prepared,
        capabilities,
        webDriverSessionId: session.sessionId,
        providerSessionId,
        interactor: createWebDriverInteractor({
          client,
          backend: snapshotBackendForPlatform(prepared.platform),
          capabilities,
        }),
      }),
    );
    this.ownedDeviceIds.add(device.id);
    return {
      provider: this.options.provider,
      deviceId: device.id,
      sessionId: session.sessionId,
      providerSessionId,
      capabilities,
      ...prepared.providerData,
    };
  }

  async release(lease: DeviceLease): Promise<LeaseResult> {
    if (lease.leaseProvider !== this.options.provider) return undefined;
    const session = this.sessionsByLeaseId.get(lease.leaseId);
    if (!session) return undefined;
    this.sessionsByLeaseId.delete(lease.leaseId);
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
    const session = query.leaseId ? this.sessionsByLeaseId.get(query.leaseId) : undefined;
    if (session) return await this.safeListArtifacts(session);
    const providerSessionId =
      query.providerSessionId ??
      (query.leaseId ? this.releasedProviderSessionIdsByLeaseId.get(query.leaseId) : undefined);
    if (!providerSessionId || !this.options.listArtifacts) return undefined;
    return await this.options.listArtifacts({
      provider: this.options.provider,
      providerSessionId,
    });
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(
      [...this.sessionsByLeaseId.values()].map(async (session) => await this.closeSession(session)),
    );
    this.sessionsByLeaseId.clear();
    this.ownedDeviceIds.clear();
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

export function buildCloudWebDriverBaseCapabilities(
  platform: CloudWebDriverPlatform,
  deviceName: string,
  configured: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    platformName: platform === 'ios' ? 'iOS' : 'Android',
    'appium:deviceName': deviceName,
    ...configured,
  };
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
