import type { CommandPolicy } from './runtime-contract.ts';

/**
 * The command policy presets. Pure literal factories: the caller decides which
 * local-path permissions a runtime gets, and these name the two default stances.
 */
export function localCommandPolicy(overrides: Partial<CommandPolicy> = {}): CommandPolicy {
  return {
    allowLocalInputPaths: true,
    allowLocalOutputPaths: true,
    maxImagePixels: 20_000_000,
    ...overrides,
  };
}

export function restrictedCommandPolicy(overrides: Partial<CommandPolicy> = {}): CommandPolicy {
  return {
    allowLocalInputPaths: false,
    allowLocalOutputPaths: false,
    maxImagePixels: 20_000_000,
    ...overrides,
  };
}
