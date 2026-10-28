// `node scripts/capability-matrix/run.ts` — prints the collected matrix as JSON.
//
// The generator in generate.ts owns the page; this entry point exists so the
// matrix can be inspected without writing one, and so a failure names the target
// that produced it instead of printing a partial table.
//
// The host platform is pinned before the platform runtimes are imported, because
// one fact reads it. `collect.ts` is imported dynamically for that reason.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MATRIX_HOST_PLATFORM, createStubHost } from './seams.ts';
import { TARGET_IDS } from './targets.ts';

export type CollectedMatrix = Readonly<{
  commands: readonly string[];
  /** Supported command list per target id, in registry order. */
  support: Readonly<Record<string, readonly string[]>>;
  /** Available operation list per target id, sorted alphabetically. */
  operations: Readonly<Record<string, readonly string[]>>;
  /** The host platform the facts were collected against. */
  hostPlatform: NodeJS.Platform;
}>;

export async function collectMatrix(): Promise<CollectedMatrix> {
  const previousPlatform = process.platform;
  Object.defineProperty(process, 'platform', {
    value: MATRIX_HOST_PLATFORM,
    configurable: true,
  });
  try {
    const { collectCommandSupport } = await import('./collect.ts');
    // Read after the import: the pin must already hold when the runtimes load,
    // because the system-audio fact reads `process.platform` at collect time.
    const appliedPlatform = process.platform;
    if (appliedPlatform !== MATRIX_HOST_PLATFORM) {
      throw new Error(
        `Facts must collect against host platform "${MATRIX_HOST_PLATFORM}" but the pin did not ` +
          `hold: process.platform is "${appliedPlatform}".`,
      );
    }
    const { commands, support, operations } = await collectCommandSupport(createStubHost());
    const missing = TARGET_IDS.filter((id) => !support.has(id));
    if (missing.length > 0) {
      throw new Error(`Capability facts are missing for: ${missing.join(', ')}`);
    }
    const ordered: Record<string, readonly string[]> = {};
    const orderedOperations: Record<string, readonly string[]> = {};
    for (const id of TARGET_IDS) {
      ordered[id] = commands.filter((command) => support.get(id)?.has(command));
      orderedOperations[id] = [...operations.get(id)!].sort();
    }
    return {
      commands,
      support: ordered,
      operations: orderedOperations,
      hostPlatform: appliedPlatform,
    };
  } finally {
    Object.defineProperty(process, 'platform', { value: previousPlatform, configurable: true });
  }
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await collectMatrix(), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  await main();
}
