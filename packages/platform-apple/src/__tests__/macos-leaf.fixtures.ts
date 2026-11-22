import type {
  MacOsLeafOperations,
  MacOsLeafTools,
  MacOsPlatformLeafRegistration,
} from '@agent-device/contracts/macos-platform-leaf';
import { missingMacOsPlatformError } from '@agent-device/contracts/plugin-installation';
import { bindMacOsLeaf } from '../macos-leaf.ts';

/** One operation the Apple owner delegated to the leaf, with the arguments it passed. */
export type MacOsLeafCall = { operation: keyof MacOsLeafOperations; args: unknown[] };

/**
 * Binds a recording macOS leaf to the Apple owner, the way a composition with the installed
 * `@agent-device/macos` package does. Each operation a test names answers the owner; any other
 * operation fails the test. The package's own tests pin what the operations do.
 */
export function bindMacOsLeafFixture(answers: Partial<MacOsLeafOperations> = {}): {
  calls: MacOsLeafCall[];
  /** The Apple tools the owner resolved for each delegated call, in order. */
  tools: MacOsLeafTools[];
} {
  const calls: MacOsLeafCall[] = [];
  const tools: MacOsLeafTools[] = [];
  const registration: MacOsPlatformLeafRegistration = {
    family: 'apple',
    appleOs: 'macos',
    bind(requestTools) {
      tools.push(requestTools);
      return new Proxy({} as MacOsLeafOperations, {
        get: (_target, name) => {
          const operation = name as keyof MacOsLeafOperations;
          return async (...args: unknown[]) => {
            calls.push({ operation, args });
            const answer = answers[operation] as ((...input: unknown[]) => unknown) | undefined;
            if (!answer) throw new Error(`macOS leaf fixture: no answer for ${operation}`);
            return await answer(...args);
          };
        },
      });
    },
  };
  bindMacOsLeaf({ active: registration, get: () => registration });
  return { calls, tools };
}

/** Binds the selection of a composition that has no macOS package installed. */
export function bindAbsentMacOsLeafFixture(): void {
  bindMacOsLeaf({
    get: () => {
      throw missingMacOsPlatformError('0.22.0-dev');
    },
  });
}
