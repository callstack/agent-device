import {
  createCloudWebDriverCapabilities,
  type CloudWebDriverCapabilityOverrides,
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';
import { buildCloudWebDriverBaseCapabilities, createCloudWebDriverRuntime } from './runtime.ts';
import {
  listAwsDeviceFarmCloudArtifacts,
  readAwsArtifacts,
  type AwsDeviceFarmArtifact,
  type AwsDeviceFarmArtifactGroup,
} from './aws-device-farm-artifacts.ts';
import type {
  CloudWebDriverPlatform,
  CloudWebDriverRuntimeOptions,
  CloudWebDriverPrepareSession,
} from './runtime.ts';
import type { DeviceLease } from '../daemon/lease-registry.ts';
import type { ProviderDeviceRuntime } from '../provider-device-runtime.ts';
import { runCmd } from '../utils/exec.ts';
import { sleep } from '../utils/timeouts.ts';
import { AppError } from '../kernel/errors.ts';
import { CLOUD_WEBDRIVER_PROVIDERS } from './providers.ts';
import { resolveLeaseValue, type LeaseValue } from './webdriver-utils.ts';

const AWS_DEVICE_FARM_PROVIDER = CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm;
export const AWS_DEVICE_FARM_CAPABILITY_OVERRIDES = {
  install: {
    support: 'unsupported',
    note: 'Pass appArn when creating the remote access session; local artifact upload/install is not implemented.',
  },
  portReverse: {
    support: 'unsupported',
    note: 'AWS Device Farm remote access does not expose agent-device port reverse.',
  },
  artifacts: {
    support: 'supported',
    note: 'AWS Device Farm remote access exposes provider-hosted video, Appium logs, and device logs after session completion.',
  },
} as const satisfies CloudWebDriverCapabilityOverrides;

export {
  listAwsDeviceFarmCloudArtifacts,
  type AwsDeviceFarmArtifact,
  type AwsDeviceFarmArtifactGroup,
} from './aws-device-farm-artifacts.ts';

export type AwsDeviceFarmRemoteAccessSession = {
  arn: string;
  status?: string;
  result?: string;
  remoteDriverEndpoint?: string;
  endpoint?: string;
  remoteDebugUrl?: string;
  remoteRecordAppUrl?: string;
  endpoints?: Record<string, string>;
  device?: {
    name?: string;
    platform?: string;
    os?: string;
  };
};

export type AwsDeviceFarmClient = {
  createRemoteAccessSession(
    input: AwsCreateRemoteAccessSessionInput,
  ): Promise<AwsDeviceFarmRemoteAccessSession>;
  getRemoteAccessSession(arn: string): Promise<AwsDeviceFarmRemoteAccessSession>;
  stopRemoteAccessSession(arn: string): Promise<AwsDeviceFarmRemoteAccessSession | undefined>;
  listArtifacts(arn: string, type: AwsDeviceFarmArtifactGroup): Promise<AwsDeviceFarmArtifact[]>;
};

export type AwsCreateRemoteAccessSessionInput = {
  projectArn: string;
  deviceArn: string;
  name: string;
  appArn?: string;
  interactionMode?: 'INTERACTIVE' | 'NO_VIDEO' | 'VIDEO_ONLY';
  configuration?: Record<string, unknown>;
};

export type AwsDeviceFarmWebDriverRuntimeOptions = {
  projectArn: string;
  deviceArn: string;
  region?: string;
  platform?: CloudWebDriverPlatform;
  deviceName?: string;
  appArn?: string;
  sessionName?: LeaseValue<string>;
  webdriverCapabilities?:
    | Record<string, unknown>
    | ((lease: DeviceLease) => Record<string, unknown>);
  client?: AwsDeviceFarmClient;
  pollIntervalMs?: number;
  startupTimeoutMs?: number;
  interactionMode?: AwsCreateRemoteAccessSessionInput['interactionMode'];
  configuration?: AwsCreateRemoteAccessSessionInput['configuration'];
  deviceId?: CloudWebDriverRuntimeOptions['deviceId'];
  requestPolicy?: CloudWebDriverRuntimeOptions['requestPolicy'];
  prepareSession?: CloudWebDriverRuntimeOptions['prepareSession'];
};

export function getAwsDeviceFarmWebDriverCapabilities(
  platform: CloudWebDriverPlatform,
): CloudWebDriverProviderCapabilities {
  return createCloudWebDriverCapabilities({
    provider: AWS_DEVICE_FARM_PROVIDER,
    platform,
    overrides: AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
  });
}

export function createAwsDeviceFarmWebDriverRuntime(
  options: AwsDeviceFarmWebDriverRuntimeOptions,
): ProviderDeviceRuntime {
  const client = options.client ?? createAwsCliDeviceFarmClient({ region: options.region });
  const platform = options.platform ?? 'android';
  const deviceName = options.deviceName ?? 'AWS Device Farm device';
  return createCloudWebDriverRuntime({
    provider: AWS_DEVICE_FARM_PROVIDER,
    endpoint: 'http://127.0.0.1/',
    platform,
    deviceName,
    webdriverCapabilities: options.webdriverCapabilities,
    prepareSession:
      options.prepareSession ??
      createAwsDeviceFarmPrepareSession({
        ...options,
        platform,
        deviceName,
        client,
      }),
    deviceId: options.deviceId,
    requestPolicy: options.requestPolicy,
    capabilityOverrides: AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
  });
}

export type AwsCliDeviceFarmClientOptions = {
  region?: string;
  awsCommand?: string;
};

export function createAwsCliDeviceFarmClient(
  options: AwsCliDeviceFarmClientOptions = {},
): AwsDeviceFarmClient {
  const runDeviceFarmJson = createAwsDeviceFarmCommandRunner(options);
  return {
    createRemoteAccessSession: async (input) => {
      const json = await runDeviceFarmJson('create-remote-access-session', [
        '--project-arn',
        input.projectArn,
        '--device-arn',
        input.deviceArn,
        '--name',
        input.name,
        ...(input.appArn ? ['--app-arn', input.appArn] : []),
        ...(input.interactionMode ? ['--interaction-mode', input.interactionMode] : []),
        ...(input.configuration ? ['--configuration', JSON.stringify(input.configuration)] : []),
      ]);
      return readRemoteAccessSession(json);
    },
    getRemoteAccessSession: async (arn) => {
      const json = await runDeviceFarmJson('get-remote-access-session', ['--arn', arn]);
      return readRemoteAccessSession(json);
    },
    stopRemoteAccessSession: async (arn) => {
      const json = await runDeviceFarmJson('stop-remote-access-session', ['--arn', arn]);
      return readRemoteAccessSession(json);
    },
    listArtifacts: async (arn, type) => {
      const json = await runDeviceFarmJson('list-artifacts', ['--arn', arn, '--type', type]);
      return readAwsArtifacts(json);
    },
  };
}

export function createAwsDeviceFarmPrepareSession(
  options: Required<
    Pick<
      AwsDeviceFarmWebDriverRuntimeOptions,
      'client' | 'platform' | 'deviceName' | 'projectArn' | 'deviceArn'
    >
  > &
    Omit<AwsDeviceFarmWebDriverRuntimeOptions, 'client' | 'platform' | 'deviceName'>,
): CloudWebDriverPrepareSession {
  return async ({ lease, base }) => {
    const remoteAccess = await options.client.createRemoteAccessSession({
      projectArn: options.projectArn,
      deviceArn: options.deviceArn,
      appArn: options.appArn,
      name: resolveLeaseValue(options.sessionName, lease) ?? `agent-device-${lease.leaseId}`,
      interactionMode: options.interactionMode,
      configuration: options.configuration,
    });
    const running = await waitForRunningRemoteAccessSession(remoteAccess.arn, options);
    const endpoint = selectAwsDeviceFarmWebDriverEndpoint(running);
    if (!endpoint) {
      throw new AppError('COMMAND_FAILED', 'AWS Device Farm did not expose a WebDriver endpoint.', {
        sessionArn: running.arn,
        status: running.status,
      });
    }
    const deviceName = running.device?.name ?? options.deviceName;
    const configured =
      typeof options.webdriverCapabilities === 'function'
        ? options.webdriverCapabilities(lease)
        : (options.webdriverCapabilities ?? {});
    return {
      ...base,
      endpoint,
      platform: options.platform,
      deviceName,
      webdriverCapabilities: buildCloudWebDriverBaseCapabilities(
        options.platform,
        deviceName,
        configured,
      ),
      cleanup: async () => {
        await options.client.stopRemoteAccessSession(running.arn);
        return { awsDeviceFarmSessionArn: running.arn };
      },
      listArtifacts: async ({ provider, providerSessionId }) =>
        await listAwsDeviceFarmCloudArtifacts(provider, providerSessionId, options.client),
      providerSessionId: running.arn,
      providerData: {
        awsDeviceFarmSessionArn: running.arn,
      },
    };
  };
}

export function selectAwsDeviceFarmWebDriverEndpoint(
  session: AwsDeviceFarmRemoteAccessSession,
): string | undefined {
  const endpointValues =
    session.endpoints && typeof session.endpoints === 'object'
      ? Object.values(session.endpoints)
      : [];
  const candidates = [
    session.remoteDriverEndpoint,
    session.endpoint,
    ...endpointValues,
    session.remoteDebugUrl,
    session.remoteRecordAppUrl,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const endpoint = candidates.find((value) => !/^wss?:\/\//i.test(value));
  return endpoint ? normalizeAwsDeviceFarmEndpoint(endpoint) : undefined;
}

function normalizeAwsDeviceFarmEndpoint(endpoint: string): string {
  return /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
}

async function waitForRunningRemoteAccessSession(
  arn: string,
  options: {
    client: AwsDeviceFarmClient;
    pollIntervalMs?: number;
    startupTimeoutMs?: number;
  },
): Promise<AwsDeviceFarmRemoteAccessSession> {
  const timeoutMs = options.startupTimeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const startedAt = Date.now();
  let last = await options.client.getRemoteAccessSession(arn);
  while (Date.now() - startedAt < timeoutMs) {
    if (last.status === 'RUNNING') return last;
    if (last.status === 'ERRORED' || last.status === 'STOPPED' || last.status === 'COMPLETED') {
      throw new AppError('COMMAND_FAILED', 'AWS Device Farm remote access session did not start.', {
        sessionArn: arn,
        status: last.status,
        result: last.result,
      });
    }
    await sleep(pollIntervalMs);
    last = await options.client.getRemoteAccessSession(arn);
  }
  throw new AppError('COMMAND_FAILED', 'Timed out waiting for AWS Device Farm remote access.', {
    sessionArn: arn,
    status: last.status,
    result: last.result,
    timeoutMs,
  });
}

async function runAwsJson(command: string, args: string[]): Promise<unknown> {
  const result = await runCmd(command, args, { maxBuffer: 10 * 1024 * 1024 });
  return JSON.parse(result.stdout) as unknown;
}

function createAwsDeviceFarmCommandRunner(
  options: AwsCliDeviceFarmClientOptions,
): (subcommand: string, args: string[]) => Promise<unknown> {
  const regionArgs = options.region ? ['--region', options.region] : [];
  const awsCommand = options.awsCommand ?? 'aws';
  return async (subcommand, args) =>
    await runAwsJson(awsCommand, [
      'devicefarm',
      subcommand,
      ...regionArgs,
      ...args,
      '--output',
      'json',
    ]);
}

function readRemoteAccessSession(value: unknown): AwsDeviceFarmRemoteAccessSession {
  if (!value || typeof value !== 'object') {
    throw new AppError('COMMAND_FAILED', 'AWS Device Farm response was not an object.', {
      response: value,
    });
  }
  const session = (value as { remoteAccessSession?: unknown }).remoteAccessSession;
  if (!session || typeof session !== 'object') {
    throw new AppError('COMMAND_FAILED', 'AWS Device Farm response missed remoteAccessSession.', {
      response: value,
    });
  }
  return session as AwsDeviceFarmRemoteAccessSession;
}
