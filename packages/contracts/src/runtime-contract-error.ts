import { createRuntimeContractInvalidError, type AppError } from '@agent-device/kernel/errors';

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
 * The shape itself lives in `kernel/errors`, so a binder that must not grow its closure, such as
 * `interactor-operation-binding.ts`, builds it from there.
 */
export function invalidRuntimeContract(message: string): AppError {
  return createRuntimeContractInvalidError(message);
}
