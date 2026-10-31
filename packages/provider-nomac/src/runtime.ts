import { execFile } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleContext,
  LeaseLifecycleProvider,
  ProviderDeviceInstallOptions,
  ProviderDeviceInstallResult,
  ProviderDeviceRuntime,
  ProviderExpiredLeaseRecovery,
} from '@agent-device/contracts/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform-runtime-operations';
import { rejectRefusedProviderProfileFields } from '@agent-device/contracts/provider-profile-fields';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { NomacClient, type NomacPhone } from './client.ts';
import {
  buildNomacDevice,
  isNomacLeaseBackend,
  NOMAC_PROFILE_FIELDS,
  NOMAC_PROVIDER,
  nomacPhoneDevice,
  parseNomacDeviceId,
} from './device.ts';
import { createNomacIosInteractor } from './interactor.ts';

export type NomacRuntimeOptions = Readonly<{
  /** The NoMac account's API key (nmk_...); a lease refuses without one. */
  apiKey?: string;
  /** https://nomac.app unless set (tests, a staging host). */
  baseUrl?: string;
  clientVersion: string;
  /** The phone's limits; NoMac's own defaults (2 hours, 10 idle minutes, $5) when left out. */
  maxDurationSeconds?: number;
  idleTimeoutSeconds?: number;
  spendCapMicrounits?: string;
  runtimeInstance?: string;
  fetch?: typeof fetch;
  /** How often a phone that is not ready yet is read again (1 s). */
  readyPollMs?: number;
  /** How long a lost start waits before its phone is looked up by label a second time (2 s). */
  labelRetryMs?: number;
  /** The host's environment, for the tar that packs an app to install (its PATH and locale). */
  env?: Readonly<Record<string, string | undefined>>;
}>;

type NomacSession = Readonly<{ lease: DeviceLease; phoneId: string; device: DeviceInfo }>;

export type NomacRuntime = ProviderDeviceRuntime & {
  recoverExpiredLease: ProviderExpiredLeaseRecovery;
  hasLiveSession(device: DeviceInfo): boolean;
};

export type NomacRuntimeRegistration = Readonly<{
  runtime: NomacRuntime;
  platformModule: PlatformRuntimeProviderModule;
}>;

// A phone from the pool is ready in seconds; one that waits in line, up to 5 minutes.
const READY_WAIT_MS = 6 * 60_000;
const READY_POLL_MS = 1_000;
const LABEL_RETRY_MS = 2_000;
const LIVE_STATES = new Set(['queued', 'provisioning', 'ready']);

export function createNomacRuntime(options: NomacRuntimeOptions): NomacRuntimeRegistration {
  const runtime = new NomacRuntimeImplementation(options);
  const owner = providerRuntimeOwner(NOMAC_PROVIDER, resolveNomacRuntimeInstance(options));
  if (owner.kind !== 'provider-runtime') throw new TypeError('Invalid NoMac runtime owner');
  return Object.freeze({
    runtime,
    platformModule: Object.freeze({
      owner,
      loadRuntime: async (host: PlatformRuntimeHost) => {
        const { createNomacPlatformRuntimeOwner } = await import('./platform-runtime.ts');
        return createNomacPlatformRuntimeOwner({
          host,
          runtimeInstance: owner.instance,
          ownsDevice: (device) => runtime.ownsDevice(device),
          hasLiveSession: (device) => runtime.hasLiveSession(device),
          getInteractor: (device, runner) => runtime.getInteractor(device, runner),
          installApp: async (device, appPath, appHint, signal) =>
            await runtime.installInstallablePath(
              device,
              appPath,
              { appIdentifierHint: appHint },
              signal,
            ),
        });
      },
    }),
  });
}

class NomacRuntimeImplementation implements NomacRuntime {
  readonly provider = NOMAC_PROVIDER;
  private readonly options: NomacRuntimeOptions;
  /** NoMac's client: a daemon without a key still starts, and only its requests (a lease's) refuse. */
  private readonly client: NomacClient;
  private readonly sessions = new Map<string, NomacSession>();
  private readonly readyPollMs: number;
  private readonly labelRetryMs: number;

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease, context) => await this.allocate(lease, context),
    release: async (lease) => await this.release(lease),
  };

  readonly recoverExpiredLease: ProviderExpiredLeaseRecovery = async (lease) => {
    if (lease.leaseProvider !== this.provider || !isNomacLeaseBackend(lease.backend)) {
      throw new AppError('UNSUPPORTED_OPERATION', 'NoMac cannot recover this expired lease.', {
        leaseId: lease.leaseId,
        leaseProvider: lease.leaseProvider,
        leaseBackend: lease.backend,
      });
    }
    await this.release(lease);
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider || !request.leaseId) return null;
    const session = this.sessions.get(request.leaseId);
    if (!session) return null;
    if (request.platform && request.platform !== 'ios' && request.platform !== 'apple') return [];
    return [session.device];
  };

  constructor(options: NomacRuntimeOptions) {
    this.options = options;
    this.client = new NomacClient(options);
    this.readyPollMs = options.readyPollMs ?? READY_POLL_MS;
    this.labelRetryMs = options.labelRetryMs ?? LABEL_RETRY_MS;
  }

  ownsDevice(device: DeviceInfo): boolean {
    return parseNomacDeviceId(device.id) !== undefined;
  }

  hasLiveSession(device: DeviceInfo): boolean {
    return this.sessionFor(device) !== undefined;
  }

  getInteractor(device: DeviceInfo, _runner?: RunnerContext): Interactor | undefined {
    const session = this.sessionFor(device);
    return session
      ? createNomacIosInteractor({ client: this.client, phoneId: session.phoneId })
      : undefined;
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
    options?: ProviderDeviceInstallOptions,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    return await this.installInstallablePath(device, appPath, {
      ...options,
      appIdentifierHint: options?.appIdentifierHint ?? app,
    });
  }

  /**
   * A .app built for the Simulator (or a .zip or .tar.gz of one) onto the phone: packed, uploaded to
   * NoMac's storage, unpacked into the phone's workspace, then installed.
   */
  async installInstallablePath(
    device: DeviceInfo,
    installablePath: string,
    options?: ProviderDeviceInstallOptions,
    signal?: AbortSignal,
  ): Promise<ProviderDeviceInstallResult | undefined> {
    const session = this.sessionFor(device);
    if (!session) return undefined;
    const archive = await packApp(installablePath, this.options.env ?? {});
    try {
      const name = `agent-device-${createHash('sha256').update(path.resolve(installablePath)).digest('hex').slice(0, 16)}`;
      const unpacked = await this.client.uploadArchive(
        session.phoneId,
        await fs.promises.readFile(archive.file),
        name,
        signal,
      );
      if (!unpacked.app) {
        throw new AppError(
          'INVALID_ARGS',
          `${path.basename(installablePath)} holds no .app built for the Simulator.`,
          {
            hint: 'Build with xcodebuild -sdk iphonesimulator; the .app is under Build/Products/Debug-iphonesimulator.',
          },
        );
      }
      const installed = await this.client.tool(
        session.phoneId,
        'app_control',
        { action: 'install', app: unpacked.app },
        signal,
      );
      if (installed.isError) {
        throw new AppError(
          'COMMAND_FAILED',
          `NoMac's phone could not install the app: ${installed.text.split('\n')[0]}`,
        );
      }
      // "Installed Demo (dev.simtap.demo)."
      const named = /Installed (.+?) \(([A-Za-z0-9.-]+)\)/.exec(installed.text);
      const bundleId = named?.[2] ?? options?.appIdentifierHint;
      return {
        ...(bundleId ? { bundleId, launchTarget: bundleId } : {}),
        ...(named?.[1] ? { appName: named[1] } : {}),
      };
    } finally {
      await archive.cleanup();
    }
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    if (sessions.length === 0) return;
    await Promise.allSettled(
      sessions.map(async (session) => await this.client.stopPhone(session.phoneId)),
    );
  }

  private async allocate(
    lease: DeviceLease,
    context?: LeaseLifecycleContext,
  ): Promise<Record<string, unknown> | undefined> {
    if (lease.leaseProvider !== this.provider || !isNomacLeaseBackend(lease.backend))
      return undefined;
    rejectRefusedProviderProfileFields(context?.flags, NOMAC_PROFILE_FIELDS);
    const existing = this.sessions.get(lease.leaseId);
    if (existing) return { nomacPhoneId: existing.phoneId, device: existing.device };
    const phoneDevice = nomacPhoneDevice(context?.flags);
    // An allocation cancelled before its start is sent starts nothing, so there is nothing to stop.
    context?.signal?.throwIfAborted();
    let phoneId: string | undefined;
    try {
      // The lease's own request key: an allocation retried after a lost answer reaches the same phone.
      const started = await this.client.startPhone(
        leaseRequestKey(lease.leaseId),
        {
          device: phoneDevice,
          label: leaseLabel(lease.leaseId),
          ...(this.phoneLimits() ? { limits: this.phoneLimits() } : {}),
        },
        context?.signal,
      );
      phoneId = started.id;
      const phone = await this.untilReady(started, context);
      context?.signal?.throwIfAborted();
      const session: NomacSession = {
        lease,
        phoneId: phone.id,
        device: buildNomacDevice(lease, phoneDevice),
      };
      this.sessions.set(lease.leaseId, session);
      return { nomacPhoneId: phone.id, device: session.device };
    } catch (error) {
      // No exit but success keeps a phone: the daemon drops a lease that failed to allocate without
      // asking the provider to release it, so whatever this allocation started stops here. A cancelled
      // allocation ends with the cancellation itself, whichever await the abort reached.
      const failure = context?.signal?.aborted ? context.signal.reason : error;
      throw await this.stopUnallocated(lease, phoneId, failure);
    }
  }

  /**
   * Stops the phone a failed or abandoned allocation started, with no signal, so the abort that ended
   * the allocation cannot stop the cleanup too. When the start's answer never came (aborted or lost in
   * flight) or was a 5xx, the phone NoMac may have made carries the lease's label and is found by it;
   * a start NoMac refused with a 4xx started nothing. A phone that cannot be stopped, or one the label
   * lookup never found, is named in the error, so it is never left unmentioned.
   */
  private async stopUnallocated(
    lease: DeviceLease,
    phoneId: string | undefined,
    error: unknown,
  ): Promise<unknown> {
    // A 4xx refused the start; after a 5xx the phone may still have been made, so it is looked up.
    const refusedStart =
      phoneId === undefined &&
      error instanceof AppError &&
      typeof error.details?.status === 'number' &&
      error.details.status < 500;
    if (refusedStart) return error;
    const label = leaseLabel(lease.leaseId);
    try {
      if (phoneId) {
        await this.client.stopPhone(phoneId);
        return error;
      }
      const phones = await this.phonesLabelled(label);
      for (const phone of phones) {
        if (LIVE_STATES.has(phone.state)) await this.client.stopPhone(phone.id);
      }
      return phones.length > 0
        ? error
        : phoneNotStopped(error, `the phone labelled ${label}, if NoMac made one`);
    } catch (stopError) {
      return phoneNotStopped(error, phoneId ?? `the phone labelled ${label}`, stopError);
    }
  }

  /**
   * The phones a lost start may have made. NoMac may not have recorded a start that was still in
   * flight when the allocation ended, so an empty answer is asked again once, after a short wait.
   */
  private async phonesLabelled(label: string): Promise<NomacPhone[]> {
    const phones = await this.client.phonesWithLabel(label);
    if (phones.length > 0) return phones;
    await sleep(this.labelRetryMs);
    return await this.client.phonesWithLabel(label);
  }

  private async untilReady(
    phone: NomacPhone,
    context?: LeaseLifecycleContext,
  ): Promise<NomacPhone> {
    const by = Math.min(Date.now() + READY_WAIT_MS, context?.deadline ?? Number.POSITIVE_INFINITY);
    let current = phone;
    for (;;) {
      if (current.state === 'ready') return current;
      if (
        current.state === 'failed' ||
        current.state === 'stopped' ||
        current.state === 'stopping'
      ) {
        throw new AppError(
          'COMMAND_FAILED',
          `NoMac's phone did not start (${current.failure_code ?? current.state}).`,
          {
            nomacPhoneId: current.id,
            hint:
              current.failure_code === 'capacity_unavailable'
                ? 'Every NoMac phone was in use for 5 minutes; try again.'
                : undefined,
          },
        );
      }
      if (Date.now() >= by) {
        throw new AppError(
          'COMMAND_FAILED',
          `NoMac's phone was not ready in time (${current.state}).`,
          { nomacPhoneId: current.id },
        );
      }
      await sleep(this.readyPollMs, undefined, { signal: context?.signal });
      current = await this.client.readPhone(current.id, context?.signal);
    }
  }

  private async release(lease: DeviceLease): Promise<Record<string, unknown> | undefined> {
    const session = this.sessions.get(lease.leaseId);
    if (session) {
      this.sessions.delete(lease.leaseId);
      await this.client.stopPhone(session.phoneId);
      return { nomacPhoneId: session.phoneId };
    }
    // A lease this daemon lost track of (a restart): its phones carry the lease's label.
    if (lease.leaseProvider !== this.provider || !isNomacLeaseBackend(lease.backend))
      return undefined;
    const phones = (await this.client.phonesWithLabel(leaseLabel(lease.leaseId))).filter((p) =>
      LIVE_STATES.has(p.state),
    );
    for (const phone of phones) await this.client.stopPhone(phone.id);
    return phones.length
      ? { nomacPhoneId: phones[0]!.id, nomacPhoneCount: phones.length }
      : undefined;
  }

  private phoneLimits(): Record<string, unknown> | undefined {
    const { maxDurationSeconds, idleTimeoutSeconds, spendCapMicrounits } = this.options;
    if (
      maxDurationSeconds === undefined &&
      idleTimeoutSeconds === undefined &&
      spendCapMicrounits === undefined
    )
      return undefined;
    return {
      max_duration_seconds: maxDurationSeconds ?? 7200,
      idle_timeout_seconds: idleTimeoutSeconds ?? 600,
      spend_cap_microunits: spendCapMicrounits ?? '5000000',
    };
  }

  private sessionFor(device: DeviceInfo): NomacSession | undefined {
    const parsed = parseNomacDeviceId(device.id);
    return parsed ? this.sessions.get(parsed.leaseId) : undefined;
  }
}

/** The allocation's error, naming the phone it may have left running. */
function phoneNotStopped(error: unknown, phone: string, stopError?: unknown): unknown {
  const details = {
    nomacPhoneNotStopped: phone,
    ...(stopError === undefined
      ? {}
      : { stopError: stopError instanceof Error ? stopError.message : String(stopError) }),
  };
  if (error instanceof AppError) {
    error.details = { ...error.details, ...details };
    return error;
  }
  return new AppError(
    'COMMAND_FAILED',
    `The NoMac allocation failed and ${phone} could not be stopped; stop it on nomac.app.`,
    details,
    error,
  );
}

/** NoMac's request keys take [A-Za-z0-9_.:-]{8,128}; a lease id that does not fit is hashed. */
export function leaseRequestKey(leaseId: string): string {
  const key = `agent-device-lease-${leaseId}`;
  return /^[A-Za-z0-9_.:-]{8,128}$/.test(key) ? key : `agent-device-lease-${hash(leaseId)}`;
}

/** NoMac's labels take [A-Za-z0-9._:@-]{1,64}. */
export function leaseLabel(leaseId: string): string {
  const label = `agent-device-${leaseId}`;
  return /^[A-Za-z0-9._:@-]{1,64}$/.test(label) ? label : `agent-device-${hash(leaseId)}`;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/** A stable owner instance per account, without the key itself in it. */
function resolveNomacRuntimeInstance(
  options: Pick<NomacRuntimeOptions, 'apiKey' | 'baseUrl' | 'runtimeInstance'>,
): string {
  if (options.runtimeInstance !== undefined) {
    const explicit = options.runtimeInstance.trim();
    if (!explicit) throw new TypeError('NoMac runtimeInstance must be a non-empty string');
    return explicit;
  }
  const principal = JSON.stringify({
    provider: NOMAC_PROVIDER,
    base: options.baseUrl ?? 'default',
    apiKey: options.apiKey,
  });
  return `principal-${scryptSync(principal, 'agent-device:nomac-runtime-owner:v1', 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
}

const execFileAsync = promisify(execFile);

/** The archive NoMac unpacks: a .zip or .tar.gz as it is, a .app directory packed into a .tar.gz. */
async function packApp(
  installablePath: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ file: string; cleanup(): Promise<void> }> {
  const stat = await fs.promises.stat(installablePath).catch(() => undefined);
  if (!stat) throw new AppError('INVALID_ARGS', `No app at ${installablePath}.`);
  if (stat.isFile()) {
    if (/\.ipa$/i.test(installablePath)) {
      throw new AppError(
        'INVALID_ARGS',
        'An .ipa is built for a real iPhone; NoMac phones are Simulators and need a Simulator .app.',
      );
    }
    if (!/\.(zip|tar\.gz|tgz)$/i.test(installablePath))
      throw new AppError(
        'INVALID_ARGS',
        `${path.basename(installablePath)} is not a .app, .zip or .tar.gz.`,
      );
    return { file: installablePath, cleanup: async () => {} };
  }
  if (!/\.app\/?$/.test(installablePath))
    throw new AppError('INVALID_ARGS', `${path.basename(installablePath)} is not a .app.`);
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-device-nomac-'));
  const cleanup = async () => await fs.promises.rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'app.tar.gz');
  const resolved = path.resolve(installablePath.replace(/\/$/, ''));
  try {
    await execFileAsync(
      'tar',
      ['-czf', file, '-C', path.dirname(resolved), path.basename(resolved)],
      { env: { ...env, COPYFILE_DISABLE: '1' } },
    );
  } catch (error) {
    await cleanup();
    throw new AppError(
      'COMMAND_FAILED',
      `Could not pack ${path.basename(resolved)} for NoMac.`,
      undefined,
      error,
    );
  }
  return { file, cleanup };
}
