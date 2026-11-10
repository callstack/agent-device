import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** True when a `-t` name filter is active, so unmatched scenarios are skipped, not missing. */
    interactionContractNameFilter: boolean;
  }
}

// `setup` is Vitest's globalSetup contract: the project imports this file by the path string in
// vitest.config.ts and calls it by name, so nothing in the source graph references it.
// fallow-ignore-next-line unused-export
export function setup(project: TestProject): void {
  project.provide(
    'interactionContractNameFilter',
    project.globalConfig.testNamePattern !== undefined,
  );
}
