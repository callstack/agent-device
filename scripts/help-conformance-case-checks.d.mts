// Type surface for the plain-Node case scorer (it must stay runnable by bare `node`).
// Keep it in step with the exports of `./help-conformance-case-checks.mjs`.
import type { PlanCommandValidation } from './help-conformance-plan-validator.mjs';

export type CasePatternCheck = { id: string; pattern: RegExp };

/** The plan a check reads: its canonical text and each command's tokens and parse. */
export type CaseCheckContext = {
  joined: string;
  commandValidation: readonly PlanCommandValidation[];
};

export type CaseTestCheck = { id: string; test: (context: CaseCheckContext) => boolean };

export type CaseChecks = {
  expectations?: readonly string[];
  matchers?: readonly (CasePatternCheck | CaseTestCheck)[];
  forbidden?: readonly CasePatternCheck[];
};

export const KNOWN_EXPECTATIONS: readonly string[];

export function assertCaseDefinitions(cases: readonly (CaseChecks & { id: string })[]): void;

export function countChecks(testCase: CaseChecks): number;

export function scoreExpectations(
  testCase: CaseChecks,
  commands: readonly string[],
  raw: string,
  commandValidation: readonly PlanCommandValidation[],
): Record<string, boolean>;
