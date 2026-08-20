import { AppError } from '@agent-device/kernel/errors';

/**
 * A runtime owner whose facts advertised an operation it cannot actually perform.
 *
 * This is a contract bug, never a legitimate refusal. Consumers must not classify it as an
 * unavailable or declined operation: doing so places it inside whatever closed reason set
 * licenses a fallback, and the command then answers from stale data precisely because the
 * runtime lied about itself (ADR 0019 §2).
 *
 * Deliberately its own module rather than an export of `platform-runtime.ts`: the façade
 * re-exports that module and must stay exhaustive over it, which would make this a public
 * symbol with no external consumer — the unused-export defect. Here it stays internal to
 * `packages/contracts` and both runtime modules share one construction.
 */
export function invalidRuntimeContract(message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'runtime-contract-invalid',
    hint: 'This is an agent-device runtime contract bug; report the selected device and command.',
  });
}
