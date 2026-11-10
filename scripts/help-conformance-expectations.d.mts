// Type surface for the plain-Node expectation scorers (they must stay runnable by bare `node`).
// Keep it in step with the exports of `./help-conformance-expectations.mjs`.
export type ExpectationContext = Readonly<{ commands: readonly string[] }>;

export function opensAndCloses(context: ExpectationContext): boolean;

export function usesValidationPrep(context: ExpectationContext): boolean;
