import Limrun from '@limrun/api';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import type { LimrunIosModel } from './device.ts';
import type { LimrunInstanceAccess } from './instance-access.ts';
import {
  LIMRUN_INSTANCE_PROBE_OPTIONS,
  LIMRUN_ORG_CLIENT_LOGGING,
  limrunUserAgent,
} from './client-options.ts';

const IOS_MODEL_NAMES: Record<LimrunIosModel, string> = {
  iphone: 'Provider-selected iOS simulator',
  ipad: 'iPad simulator',
  watch: 'Apple Watch simulator',
};

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
  clientVersion: string;
  instances?: LimrunInstanceAccess;
  platform: 'android' | 'ios';
  region?: string;
  iosModel?: LimrunIosModel;
};

/** Verifies the instance access for the platform when given, otherwise the organization API key. */
export async function verifyLimrunConnection(
  options: LimrunConnectionVerificationOptions,
): Promise<LimrunConnectionVerification> {
  const attached = await verifyAttachedInstance(options);
  if (attached) return attached;
  if (!options.apiKey) {
    throw new AppError(
      'INVALID_ARGS',
      'Limrun verification requires an API key or instance access.',
    );
  }
  const client = new Limrun({
    apiKey: options.apiKey,
    userAgent: limrunUserAgent(options.clientVersion),
    timeout: 15_000,
    maxRetries: 0,
    ...LIMRUN_ORG_CLIENT_LOGGING,
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
    throw new AppError('COMMAND_FAILED', 'Limrun connection verification failed.', {
      hint: 'Check Limrun service access, LIMRUN_REGION, and network connectivity, then retry.',
      ...(status === undefined ? {} : { status }),
    });
  }
  const platformName = options.platform === 'android' ? 'Android' : 'iOS';
  const deviceName =
    options.platform === 'android'
      ? 'Provider-selected Android emulator'
      : IOS_MODEL_NAMES[options.iosModel ?? 'iphone'];
  return {
    provider: 'limrun',
    service: 'Limrun',
    verificationMessage: `Credentials and ${platformName} instance access verified.`,
    device: {
      status: 'deferred',
      name: deviceName,
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

function connectAttachedInstance(
  options: LimrunConnectionVerificationOptions,
): Promise<{ disconnect(): void; deviceInfo?: { model?: string } }> | undefined {
  const clientOptions = LIMRUN_INSTANCE_PROBE_OPTIONS;
  const { ios, android } = options.instances ?? {};
  if (options.platform === 'android') {
    return (
      android &&
      import('@limrun/api/instance-client').then(({ createInstanceClient }) =>
        createInstanceClient({ ...clientOptions, ...android }),
      )
    );
  }
  return (
    ios &&
    import('@limrun/api/ios-client').then(({ createInstanceClient }) =>
      createInstanceClient({ ...clientOptions, ...ios }),
    )
  );
}

async function verifyAttachedInstance(
  options: LimrunConnectionVerificationOptions,
): Promise<LimrunConnectionVerification | undefined> {
  const connecting = connectAttachedInstance(options);
  if (!connecting) return undefined;
  const android = options.platform === 'android';
  const platformName = android ? 'Android' : 'iOS';
  let model: string | undefined;
  try {
    const client = await connecting;
    model = client.deviceInfo?.model;
    client.disconnect();
  } catch {
    throw new AppError('COMMAND_FAILED', `Limrun ${platformName} instance access failed.`, {
      hint: android
        ? 'Check LIM_ANDROID_INSTANCE_URL, LIM_ANDROID_INSTANCE_TOKEN, and LIM_ANDROID_INSTANCE_ADB_URL, and that the instance is still running.'
        : 'Check LIM_IOS_INSTANCE_URL and LIM_IOS_INSTANCE_TOKEN, and that the instance is still running.',
    });
  }
  return {
    provider: 'limrun',
    service: 'Limrun',
    verificationMessage: `Existing ${platformName} instance access verified. A daemon started with these variables drives it without creating or deleting it.`,
    device: {
      status: 'verified',
      name: model || `Existing ${platformName} ${android ? 'emulator' : 'simulator'}`,
      platform: options.platform,
    },
    app: {
      status: 'missing',
      message: 'Run open <bundle-or-package-id> to use an app installed on the instance.',
    },
  };
}
