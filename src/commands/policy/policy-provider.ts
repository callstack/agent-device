import { AppError } from '@agent-device/kernel/errors';
import {
  createJevPolicyProvider,
  JEV_PROVIDER_NAME,
  POLICY_FALLBACK_HINT,
} from './jev-policy-provider.ts';
import type { PolicyProvider } from './policy-contract.ts';

/** Every policy head the CLI can resolve. One ships today. */
export const POLICY_PROVIDER_NAMES = [JEV_PROVIDER_NAME] as const;
export type PolicyProviderName = (typeof POLICY_PROVIDER_NAMES)[number];
export const DEFAULT_POLICY_PROVIDER: PolicyProviderName = JEV_PROVIDER_NAME;

/** Environment keys the jev provider reads. The key is never accepted as a CLI flag. */
export const JEV_API_KEY_ENV = 'TYPESAFE_API_KEY';
export const JEV_MODEL_ENV = 'AGENT_DEVICE_POLICY_MODEL';
export const JEV_ENDPOINT_ENV = 'AGENT_DEVICE_POLICY_ENDPOINT';

export type PolicyProviderEnvironment = Readonly<Record<string, string | undefined>>;

export function isPolicyProviderName(value: string): value is PolicyProviderName {
  return (POLICY_PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * Resolve a provider by name.
 *
 * The credential comes from the environment only, so it never reaches argv, a recorded script, a
 * session journal, or an MCP tool schema. Without it the command refuses before touching the
 * device, which is what keeps the feature invisible to everyone who has not opted in.
 */
export function createPolicyProvider(
  name: string,
  env: PolicyProviderEnvironment,
  overrides: { fetch?: typeof globalThis.fetch } = {},
): PolicyProvider {
  if (!isPolicyProviderName(name)) {
    throw new AppError(
      'INVALID_ARGS',
      `Unknown policy provider ${name}; available: ${POLICY_PROVIDER_NAMES.join(', ')}`,
    );
  }
  const apiKey = env[JEV_API_KEY_ENV]?.trim();
  if (!apiKey) {
    throw new AppError(
      'INVALID_ARGS',
      `${JEV_API_KEY_ENV} is not set, so policy ${name} cannot decide`,
      {
        reason: 'policy-provider-unconfigured',
        hint: `Export ${JEV_API_KEY_ENV} to enable the policy head. Without it, ${POLICY_FALLBACK_HINT}`,
      },
    );
  }
  return createJevPolicyProvider({
    apiKey,
    model: env[JEV_MODEL_ENV],
    endpoint: env[JEV_ENDPOINT_ENV],
    ...overrides,
  });
}
