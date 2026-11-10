// Type surface for the plain-Node plan validator (it must stay runnable by bare `node`).
// TypeScript resolves this file when a checked module imports
// `./help-conformance-plan-validator.mjs`; keep it in step with the exports there.
export type PlanCommandIssue = { kind: string; error: string };

export type PlanAgentCommand = { command: string; positionals: string[] };

export type PlanCommandValidation = {
  command: string;
  tokens: string[];
  issues: PlanCommandIssue[];
  agentCommand?: PlanAgentCommand;
};

export function validatePlanCommands(
  commands: readonly string[],
  options?: Readonly<{ allowedExternalCommands?: readonly string[] }>,
): Promise<PlanCommandValidation[]>;
