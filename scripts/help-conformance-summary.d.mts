// Type surface for the plain-Node result summary (it must stay runnable by bare `node`).
// Keep it in step with the exports of `./help-conformance-summary.mjs`.
import type { PlanCommandIssue } from './help-conformance-plan-validator.mjs';

export type BenchTrialResult = Readonly<{
  runner: string;
  caseId: string;
  passed: boolean;
  checks?: Readonly<Record<string, boolean>>;
  commandValidation?: readonly Readonly<{ issues?: readonly PlanCommandIssue[] }>[];
  runnerError?: string;
  runnerErrorReason?: string;
}>;

export type BenchCaseSummary = {
  runner: string;
  caseId: string;
  trials: number;
  evaluatedTrials: number;
  passed: number;
  failedChecks: Record<string, number>;
  validationIssues: Record<string, number>;
  runnerErrors: number;
  passRate: number | null;
};

export function summarizeResults(results: readonly BenchTrialResult[]): BenchCaseSummary[];
