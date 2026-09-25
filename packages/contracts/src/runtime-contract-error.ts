import { AppError } from '@agent-device/kernel/errors';

/**
 * A runtime owner whose facts advertised an operation it cannot actually perform.
 *
 * This is a contract bug, never a legitimate refusal. Consumers must not classify it as an
 * unavailable or declined operation: doing so places it inside whatever closed reason set
 * licenses a fallback, and the command then answers from stale data precisely because the
 * runtime lied about itself (ADR 0019 §2).
 *
 * Deliberately its own module rather than an export of `platform-runtime.ts`: that façade must stay
 * exhaustive over its sources and keep its eager closure at budget, so it carries no leaf value
 * symbol nobody in `contracts` consumes. This module stays a subpath of its own and imports nothing
 * else from `contracts`, so a platform package whose facts advertised an operation its interactor
 * cannot perform builds the same failure here instead of restating the code, reason, and hint.
 */
export function invalidRuntimeContract(message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'runtime-contract-invalid',
    hint: 'This is an agent-device runtime contract bug; report the selected device and command.',
  });
}
