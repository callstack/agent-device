import type { LimrunInstanceAccess } from '@agent-device/provider-limrun';
import { AppError } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';

export type LimrunCredentials = Readonly<{
  apiKey?: string;
  region?: string;
  keepAlive?: boolean;
  instances?: LimrunInstanceAccess;
}>;

const INSTANCE_VARS = {
  ios: ['LIM_IOS_INSTANCE_URL', 'LIM_IOS_INSTANCE_TOKEN'],
  android: [
    'LIM_ANDROID_INSTANCE_URL',
    'LIM_ANDROID_INSTANCE_TOKEN',
    'LIM_ANDROID_INSTANCE_ADB_URL',
  ],
} as const;

/** The variables that give access to an existing instance of a platform. */
export function limrunInstanceVariables(platform: 'ios' | 'android'): readonly string[] {
  return INSTANCE_VARS[platform];
}

/**
 * The one reader of Limrun credentials in the environment. Instance variables use the `lim` CLI
 * names, so an orchestrator hands a sandbox one set of variables for both tools.
 */
export function readLimrunCredentials(env: EnvMap): LimrunCredentials | undefined {
  const apiKey = env.LIMRUN_API_KEY?.trim() || undefined;
  const region = env.LIMRUN_REGION?.trim() || undefined;
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
  const entries = names.map((name) => [name, env[name]?.trim() || undefined] as const);
  if (entries.every(([, value]) => value === undefined)) return undefined;
  const missing = entries.filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    throw new AppError('INVALID_ARGS', `Limrun instance access is missing ${missing.join(', ')}.`, {
      hint: `Set ${names.join(', ')} together from the instance status, or unset them all.`,
    });
  }
  return Object.fromEntries(entries) as Record<Name, string>;
}
