import { AppError } from '@agent-device/kernel/errors';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import { DoublespeedApiClient } from './api-client.ts';

export type DoublespeedConnectionVerification = ProviderConnectionVerification & {
  provider: 'doublespeed';
  service: 'Doublespeed';
  device: {
    status: 'deferred';
    name: string;
    platform: 'ios';
  };
  app: {
    status: 'missing';
    message: string;
  };
};

export type DoublespeedConnectionVerificationOptions = {
  apiKey: string;
  apiUrl?: string;
  clientVersion: string;
  device?: string;
};

export async function verifyDoublespeedConnection(
  options: DoublespeedConnectionVerificationOptions,
): Promise<DoublespeedConnectionVerification> {
  const client = new DoublespeedApiClient(options);
  try {
    await client.listSimulators({});
  } catch (error) {
    if (error instanceof AppError && error.code === 'UNAUTHORIZED') {
      throw new AppError('UNAUTHORIZED', 'Doublespeed rejected connection verification.', {
        hint: 'Check DOUBLESPEED_API_KEY and its organization access.',
      });
    }
    throw new AppError(
      'COMMAND_FAILED',
      'Doublespeed connection verification failed.',
      {
        hint: 'Check Doublespeed service access, DOUBLESPEED_API_URL, and network connectivity, then retry.',
      },
      error,
    );
  }
  return {
    provider: 'doublespeed',
    service: 'Doublespeed',
    verificationMessage: 'Credentials and iOS simulator access verified.',
    device: {
      status: 'deferred',
      name: options.device
        ? `Doublespeed ${options.device} simulator`
        : 'Provider-selected iOS simulator',
      platform: 'ios',
    },
    app: {
      status: 'missing',
      message: 'A new Doublespeed simulator does not have your app yet.',
    },
  };
}
