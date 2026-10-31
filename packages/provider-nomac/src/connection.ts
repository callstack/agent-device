import type { CliFlags } from '@agent-device/contracts/command';
import { rejectRefusedProviderProfileFields } from '@agent-device/contracts/provider-profile-fields';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import { NomacClient } from './client.ts';
import { NOMAC_PROFILE_FIELDS, NOMAC_PROVIDER, nomacPhoneDevice } from './device.ts';

export const NOMAC_CREDENTIAL_VARIABLE = 'NOMAC_API_KEY';
export const NOMAC_BASE_URL_VARIABLE = 'NOMAC_API_URL';

const MODELS: Record<ReturnType<typeof nomacPhoneDevice>, string> = {
  iphone: 'iPhone 17 Pro (iOS 27)',
  ipad: 'iPad Pro 11-inch (M5) (iOS 27)',
};

export function requireNomacApiKey(
  env: Readonly<Record<string, string | undefined>>,
  command: string,
): string {
  const key = env[NOMAC_CREDENTIAL_VARIABLE]?.trim();
  if (!key) {
    throw new AppError(
      'INVALID_ARGS',
      `${command} needs ${NOMAC_CREDENTIAL_VARIABLE}, a NoMac account's API key.`,
      {
        hint: 'Create one at https://nomac.app/dashboard, or with `npx simulator-use cloud start`.',
      },
    );
  }
  return key;
}

function requireIosPlatform(flags: CliFlags): 'ios' {
  const platform = flags.platform;
  if (platform !== undefined && platform !== 'ios' && platform !== 'apple') {
    throw new AppError(
      'INVALID_ARGS',
      `NoMac serves iOS phones only; leave --platform out or pass ios.`,
    );
  }
  return 'ios';
}

/** `agent-device connect nomac`: the profile a lease reads; no phone starts until a device command. */
export function resolveNomacConnection({
  flags,
  env,
}: {
  flags: CliFlags;
  env: Readonly<Record<string, string | undefined>>;
}) {
  rejectRefusedProviderProfileFields(flags, NOMAC_PROFILE_FIELDS);
  requireNomacApiKey(env, `connect ${NOMAC_PROVIDER}`);
  const platform = requireIosPlatform(flags);
  nomacPhoneDevice(flags);
  return {
    profile: {
      leaseProvider: NOMAC_PROVIDER,
      platform,
      ...(flags.device ? { device: flags.device } : {}),
      ...(flags.providerOsVersion ? { providerOsVersion: flags.providerOsVersion } : {}),
    } as const,
  };
}

/** Checks the key against NoMac: it reads the account's phones, which needs NoMac Simulator on for it. */
export async function verifyNomacConnection({
  flags,
  env,
  clientVersion,
  fetch,
}: {
  flags: CliFlags;
  env: Readonly<Record<string, string | undefined>>;
  clientVersion: string;
  fetch?: typeof globalThis.fetch;
}): Promise<ProviderConnectionVerification> {
  const apiKey = requireNomacApiKey(env, `connect ${NOMAC_PROVIDER}`);
  const phone = nomacPhoneDevice(flags);
  const client = new NomacClient({
    apiKey,
    baseUrl: env[NOMAC_BASE_URL_VARIABLE],
    clientVersion,
    fetch,
  });
  await client.request('GET', '/api/v1/simulator/sessions', { timeoutMs: 15_000 });
  return {
    provider: NOMAC_PROVIDER,
    service: 'NoMac',
    verificationMessage: 'NoMac key and NoMac Simulator access verified.',
    device: { status: 'deferred', name: MODELS[phone], platform: 'ios' },
    app: {
      status: 'missing',
      message:
        'Install a Simulator .app after the phone starts: agent-device install <app> <path>.',
    },
  };
}
