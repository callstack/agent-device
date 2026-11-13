// Type surface for the plain-Node expectation scorers (they must stay runnable by bare `node`).
// Keep it in step with the exports of `./help-conformance-expectations.mjs`.
import type { PlanCommandValidation } from './help-conformance-plan-validator.mjs';

export type ExpectationContext = Readonly<{ commands: readonly string[] }>;

export function opensAndCloses(context: ExpectationContext): boolean;

export function usesValidationPrep(context: ExpectationContext): boolean;

export function hasFindExists(
  commandValidation: readonly PlanCommandValidation[],
  subject?: string,
): boolean;
