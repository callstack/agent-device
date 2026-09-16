import { POLICY_INPUT_ENV_PREFIX } from '@agent-device/command-registry/flag-definitions-workflow';
import { AppError } from '@agent-device/kernel/errors';
import type { PolicyCandidate } from './policy-contract.ts';

/**
 * Text the loop may send to a field, keyed by a name the caller chooses. The loop never invents
 * text: a field with no matching entry escalates instead of being filled with a guess.
 */
export type PolicyTextInputs = ReadonlyMap<string, string>;

/** Parse repeated `--input key=value` tokens. An empty value is allowed; an empty key is not. */
export function parsePolicyTextInputs(tokens: readonly string[]): Map<string, string> {
  const inputs = new Map<string, string>();
  for (const token of tokens) {
    const separator = token.indexOf('=');
    const key = separator === -1 ? '' : token.slice(0, separator).trim();
    if (!key) {
      throw new AppError('INVALID_ARGS', `--input expects key=value, received ${token}`);
    }
    inputs.set(key.toLowerCase(), token.slice(separator + 1));
  }
  return inputs;
}

/** The environment name that carries `key`, for callers who keep secrets out of argv. */
export function policyInputEnvName(key: string): string {
  return `${POLICY_INPUT_ENV_PREFIX}${key.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`;
}

export type ResolvedTextInput = { key: string; text: string };

/**
 * Find the text for a field.
 *
 * Matching runs from most to least specific — identifier, label, then either one containing the
 * key — so `--input phone=...` reaches a field identified `phoneField` without also matching a
 * "Phone support" link. Environment entries are consulted for the same keys, which is how an OTP
 * or password reaches the loop without being written into a command line.
 */
export function resolveTextInput(
  candidate: PolicyCandidate,
  inputs: PolicyTextInputs,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedTextInput | undefined {
  const identifier = candidate.identifier?.toLowerCase() ?? '';
  const name = candidate.name.toLowerCase();
  const keys = new Set([...inputs.keys(), ...environmentKeys(env)]);

  const matchers: Array<(key: string) => boolean> = [
    (key) => identifier === key || name === key,
    (key) => identifier.includes(key) || name.includes(key),
  ];
  for (const matches of matchers) {
    for (const key of keys) {
      if (!matches(key)) continue;
      const text = inputs.get(key) ?? env[policyInputEnvName(key)];
      if (text !== undefined) return { key, text };
    }
  }
  return undefined;
}

function environmentKeys(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith(POLICY_INPUT_ENV_PREFIX))
    .map((name) => name.slice(POLICY_INPUT_ENV_PREFIX.length).toLowerCase());
}
