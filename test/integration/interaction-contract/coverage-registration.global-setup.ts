import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** True when a `-t` name filter is active, so unmatched scenarios are skipped, not missing. */
    interactionContractNameFilter: boolean;
  }
}

export default function setup(project: TestProject): void {
  project.provide(
    'interactionContractNameFilter',
    project.globalConfig.testNamePattern !== undefined,
  );
}
