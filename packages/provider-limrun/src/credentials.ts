import { AppError, PROVIDER_CREDENTIAL_REASONS } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { LimrunPlatform } from './device.ts';
import type { LimrunInstanceAccess } from './instance-access.ts';

export const LIMRUN_CREDENTIAL_DORMANCY = Object.freeze({
  reason: PROVIDER_CREDENTIAL_REASONS.missing.reason,
  message: 'Limrun requires LIMRUN_API_KEY, or an instance variable set.',
  hint: 'Set LIMRUN_API_KEY for the account, or the full LIM_IOS_INSTANCE_* or LIM_ANDROID_INSTANCE_* set for an existing instance.',
});

/** The Limrun account and instance facts one host gives the provider. */
export type LimrunCredentials = Readonly<{
  apiKey?: string;
  region?: string;
  keepAlive?: boolean;
  instances?: LimrunInstanceAccess;
}>;

const ACCOUNT_VARS = { apiKey: 'LIMRUN_API_KEY', region: 'LIMRUN_REGION' } as const;

const INSTANCE_VARS = {
  ios: ['LIM_IOS_INSTANCE_URL', 'LIM_IOS_INSTANCE_TOKEN'],
  android: [
    'LIM_ANDROID_INSTANCE_URL',
    'LIM_ANDROID_INSTANCE_TOKEN',
    'LIM_ANDROID_INSTANCE_ADB_URL',
  ],
} as const;

/** Every variable that selects which Limrun account or instance the credentials reach. */
const LIMRUN_CREDENTIAL_VARIABLES: readonly string[] = [
  ...Object.values(ACCOUNT_VARS),
  ...INSTANCE_VARS.ios,
  ...INSTANCE_VARS.android,
];

/**
 * The variables a Limrun lease reads: the account variables plus the leased platform's instance
 * variables, or every variable when the lease backend names no platform. The per-backend narrowing
 * is what lets a client fingerprint the credentials of the one platform its lease reaches.
 */
export function limrunCredentialDeclaration(): Readonly<{
  variables: readonly string[];
  byBackend: Readonly<Record<string, readonly string[]>>;
}> {
  const account = Object.values(ACCOUNT_VARS);
  const backends: readonly [string, LimrunPlatform][] = [
    ['ios-instance', 'ios'],
    ['android-instance', 'android'],
  ];
  return {
    variables: LIMRUN_CREDENTIAL_VARIABLES,
    byBackend: Object.fromEntries(
      backends.map(([backend, platform]) => [backend, [...account, ...INSTANCE_VARS[platform]]]),
    ),
  };
}

/** The variables that give access to an existing instance of a platform. */
export function limrunInstanceVariables(platform: LimrunPlatform): readonly string[] {
  return INSTANCE_VARS[platform];
}

/**
 * The credentials one host must hold before Limrun can act on them: this reader's answer, or the
 * typed refusal that names both ways in.
 */
export function requireLimrunCredentials(env: EnvMap): LimrunCredentials {
  const credentials = readLimrunCredentials(env);
  if (credentials) return credentials;
  const { message, reason, hint } = LIMRUN_CREDENTIAL_DORMANCY;
  throw new AppError('INVALID_ARGS', message, { reason, hint });
}

/**
 * The one reader of Limrun credentials in the environment. Instance variables use the `lim` CLI
 * names, so an orchestrator hands a sandbox one set of variables for both tools.
 */
export function readLimrunCredentials(env: EnvMap): LimrunCredentials | undefined {
  const apiKey = readValue(env, ACCOUNT_VARS.apiKey);
  const region = readValue(env, ACCOUNT_VARS.region);
  const keepAlive = ['1', 'true'].includes(env.LIMRUN_KEEP_ALIVE?.trim().toLowerCase() ?? '');
  const ios = readInstanceVars(env, INSTANCE_VARS.ios);
  const android = readInstanceVars(env, INSTANCE_VARS.android);
  if (!apiKey && !ios && !android) return undefined;
  const instances: LimrunInstanceAccess = {
    ios: ios && { apiUrl: ios.LIM_IOS_INSTANCE_URL, token: ios.LIM_IOS_INSTANCE_TOKEN },
    android: android && {
      apiUrl: android.LIM_ANDROID_INSTANCE_URL,
      token: android.LIM_ANDROID_INSTANCE_TOKEN,
      adbUrl: android.LIM_ANDROID_INSTANCE_ADB_URL,
    },
  };
  return { apiKey, region, keepAlive, instances: ios || android ? instances : undefined };
}

function readInstanceVars<Name extends string>(
  env: EnvMap,
  names: readonly Name[],
): Readonly<Record<Name, string>> | undefined {
  const entries = names.map((name) => [name, readValue(env, name)] as const);
  if (entries.every(([, value]) => value === undefined)) return undefined;
  const missing = entries.filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    throw new AppError('INVALID_ARGS', `Limrun instance access is missing ${missing.join(', ')}.`, {
      hint: `Set ${names.join(', ')} together from the instance status, or unset them all.`,
    });
  }
  return Object.fromEntries(entries) as Record<Name, string>;
}

function readValue(env: EnvMap, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}
