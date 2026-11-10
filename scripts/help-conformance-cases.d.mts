// Type surface for the plain-Node benchmark cases (they must stay runnable by bare `node`).
// Keep it in step with the exports of `./help-conformance-cases.mjs`.
import type { CaseChecks } from './help-conformance-case-checks.mjs';
import type { CapturedSample } from './help-conformance-sample-outputs.mjs';

export type BenchmarkCase = CaseChecks & {
  id: string;
  docs: readonly string[];
  task: string;
  allowedExternalCommands?: readonly string[];
  recovery?: Readonly<{ code: string; sample: CapturedSample }>;
};

export const CASES: readonly BenchmarkCase[];
