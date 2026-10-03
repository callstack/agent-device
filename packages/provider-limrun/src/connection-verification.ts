import Limrun from '@limrun/api';
import { AppError } from '@agent-device/kernel/errors';
import { buildLimrunClientOptions } from './client-options.ts';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import type { LimrunInstanceAccess } from './instance-access.ts';

export type LimrunConnectionVerification = ProviderConnectionVerification & {
  provider: 'limrun';
  service: 'Limrun';
  device: {
    status: 'deferred' | 'verified';
    name: string;
    platform: 'android' | 'ios';
  };
  app: {
    status: 'missing';
    message: string;
  };
};

export type LimrunConnectionVerificationOptions = {
  apiKey?: string;
  instances?: LimrunInstanceAccess;
  clientVersion: string;
  platform: 'android' | 'ios';
  region?: string;
};

/** Verifies the instance access for the platform when given, otherwise the organization API key. */
export async function verifyLimrunConnection(
  options: LimrunConnectionVerificationOptions,
): Promise<LimrunConnectionVerification> {
  const connectAttached = attachedInstanceConnector(options);
  if (connectAttached) return await verifyAttachedInstance(options.platform, connectAttached);
  if (!options.apiKey) {
    throw new AppError(
      'INVALID_ARGS',
      'Limrun verification requires an API key or instance access.',
    );
  }
  const client = new Limrun({
    ...buildLimrunClientOptions({ apiKey: options.apiKey, clientVersion: options.clientVersion }),
    timeout: 15_000,
    maxRetries: 0,
  });
  const query = { limit: 1, ...(options.region ? { region: options.region } : {}) };
  try {
    if (options.platform === 'android') {
      await client.androidInstances.list(query);
    } else {
      await client.iosInstances.list(query);
    }
  } catch (error) {
    const status = readStatus(error);
    if (status === 401 || status === 403) {
      throw new AppError('UNAUTHORIZED', 'Limrun rejected connection verification.', {
        status,
        hint: 'Check LIMRUN_API_KEY and its organization access.',
      });
    }
    throw new AppError(
      'COMMAND_FAILED',
      'Limrun connection verification failed.',
      { hint: 'Check Limrun service access, LIMRUN_REGION, and network connectivity, then retry.' },
      error,
    );
  }
  const platformName = options.platform === 'android' ? 'Android' : 'iOS';
  const deviceKind = options.platform === 'android' ? 'emulator' : 'simulator';
  return {
    provider: 'limrun',
    service: 'Limrun',
    verificationMessage: `Credentials and ${platformName} instance access verified.`,
    device: {
      status: 'deferred',
      name: `Provider-selected ${platformName} ${deviceKind}`,
      platform: options.platform,
    },
    app: {
      status: 'missing',
      message: 'Run apps to choose an uploaded asset before allocation.',
    },
  };
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

type InstanceConnector = () => Promise<{ disconnect(): void }>;

function attachedInstanceConnector(
  options: LimrunConnectionVerificationOptions,
): InstanceConnector | undefined {
  const clientOptions = { logLevel: 'none', maxReconnectAttempts: 0 } as const;
  const ios = options.instances?.ios;
  if (options.platform === 'ios' && ios) {
    return async () =>
      await (
        await import('@limrun/api/ios-client')
      ).createInstanceClient({ ...clientOptions, ...ios });
  }
  const android = options.instances?.android;
  if (options.platform === 'android' && android) {
    return async () =>
      await (
        await import('@limrun/api/instance-client')
      ).createInstanceClient({ ...clientOptions, ...android });
  }
  return undefined;
}

async function verifyAttachedInstance(
  platform: 'android' | 'ios',
  connect: InstanceConnector,
): Promise<LimrunConnectionVerification> {
  const platformName = platform === 'android' ? 'Android' : 'iOS';
  const instanceVars =
    platform === 'android'
      ? 'LIM_ANDROID_INSTANCE_URL, LIM_ANDROID_INSTANCE_TOKEN, and LIM_ANDROID_INSTANCE_ADB_URL'
      : 'LIM_IOS_INSTANCE_URL and LIM_IOS_INSTANCE_TOKEN';
  try {
    const client = await connect();
    client.disconnect();
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Limrun ${platformName} instance access failed.`,
      {
        hint: `Check ${instanceVars}, and that the instance is still running.`,
      },
      error,
    );
  }
  return {
    provider: 'limrun',
    service: 'Limrun',
    verificationMessage: `Existing ${platformName} instance access verified. agent-device will not create or delete it.`,
    device: {
      status: 'verified',
      name: `Existing ${platformName} ${platform === 'android' ? 'emulator' : 'simulator'}`,
      platform,
    },
    app: {
      status: 'missing',
      message: 'Run open <bundle-or-package-id> to use an app installed on the instance.',
    },
  };
}
