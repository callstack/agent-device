import Limrun from '@limrun/api';
import { AppError } from '@agent-device/kernel/errors';
import { buildLimrunClientOptions } from './client-options.ts';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';

export type LimrunConnectionVerification = ProviderConnectionVerification & {
  provider: 'limrun';
  service: 'Limrun';
  device: {
    status: 'deferred';
    name: string;
    platform: 'android' | 'ios';
  };
  app: {
    status: 'missing';
    message: string;
  };
};

export type LimrunConnectionVerificationOptions = {
  apiKey: string;
  clientVersion: string;
  platform: 'android' | 'ios';
  region?: string;
};

export async function verifyLimrunConnection(
  options: LimrunConnectionVerificationOptions,
): Promise<LimrunConnectionVerification> {
  const client = new Limrun({
    ...buildLimrunClientOptions(options),
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
      message: 'A new Limrun instance does not have your app yet.',
    },
  };
}

function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}
