import { AppError } from '@agent-device/kernel/errors';
import { buildJevRequest, readJevDecision } from './jev-composer.ts';
import type { PolicyDecision, PolicyProvider, PolicyRequest } from './policy-contract.ts';

export const JEV_PROVIDER_NAME = 'jev';
export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
const JEV_TIMEOUT_MS = 20_000;

/**
 * The documented recovery when the policy head is unreachable. It names the agent's own loop
 * because that loop is always available: the policy head is an accelerator, never a dependency.
 */
export const POLICY_FALLBACK_HINT =
  'Fall back to agent-driven policy: snapshot, choose an element yourself, then press or fill it.';

export type JevProviderOptions = {
  apiKey: string;
  model?: string;
  endpoint?: string;
  /** Injected so unit tests exercise the real composer and parser against a fake transport. */
  fetch?: typeof globalThis.fetch;
  /** Injected so step timings are assertable. */
  now?: () => number;
};

export function createJevPolicyProvider(options: JevProviderOptions): PolicyProvider {
  const model = options.model ?? JEV_DEFAULT_MODEL;
  const endpoint = options.endpoint ?? JEV_DEFAULT_ENDPOINT;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());

  return {
    name: JEV_PROVIDER_NAME,
    model,
    decide: async (request: PolicyRequest): Promise<PolicyDecision> => {
      const body = buildJevRequest(model, request);
      const startedAt = now();
      const response = await callJev(fetchImpl, endpoint, options.apiKey, body);
      if (!response.ok) throw unavailable(response.status, await readErrorText(response));
      const parsed: unknown = await response.json();
      return readJevDecision(parsed, request, {
        provider: JEV_PROVIDER_NAME,
        model,
        decideMs: now() - startedAt,
      });
    },
  };
}

async function callJev(
  fetchImpl: typeof globalThis.fetch,
  endpoint: string,
  apiKey: string,
  body: unknown,
): Promise<Response> {
  try {
    return await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Jev unavailable: ${error instanceof Error ? error.message : 'request failed'}`,
      { reason: 'policy-provider-transport', retriable: true, hint: POLICY_FALLBACK_HINT },
      error,
    );
  }
}

/**
 * Status is carried as a typed `reason` and `status` detail rather than being sniffed back out of
 * the message, so a caller can branch on it without matching text.
 */
function unavailable(status: number, detail: string): AppError {
  const code = status === 401 || status === 403 ? 'UNAUTHORIZED' : 'COMMAND_FAILED';
  return new AppError(
    code,
    `Jev unavailable: ${status}${detail ? ` ${detail}` : ''}; fall back to agent-driven policy`,
    {
      reason: reasonForStatus(status),
      status,
      retriable: status === 429 || status >= 500,
      hint: hintForStatus(status),
    },
  );
}

function reasonForStatus(status: number): string {
  if (status === 401 || status === 403) return 'policy-provider-unauthorized';
  if (status === 402) return 'policy-provider-payment-required';
  if (status === 429) return 'policy-provider-rate-limited';
  return 'policy-provider-http';
}

function hintForStatus(status: number): string {
  if (status === 401 || status === 403) {
    return `TYPESAFE_API_KEY is missing or rejected. ${POLICY_FALLBACK_HINT}`;
  }
  if (status === 402) return `The TypeSafe account has no credit. ${POLICY_FALLBACK_HINT}`;
  if (status === 429) {
    return `Rate limited; keep policy concurrency at or below 4. ${POLICY_FALLBACK_HINT}`;
  }
  return POLICY_FALLBACK_HINT;
}

async function readErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200).replaceAll(/\s+/gu, ' ').trim();
  } catch {
    return '';
  }
}
