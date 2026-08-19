// Expectation-carrying cases for the validation fuzz targets (#1781 B2).
//
// The classic targets judge only rejections ("fails well"), which cannot see the bug class
// #1433 belonged to: a parser that silently ACCEPTS input it should refuse. A validation case
// therefore carries its own expected outcome, decided by the generator that constructed it —
// it knows whether it built a valid command line or planted a specific violation. The case
// travels as one JSON string so the existing corpus, artifact, repro, and worker plumbing
// carry it unchanged.

import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { describeThrown } from './invariant.ts';
import type { FuzzFailure, FuzzTargetName } from './target-types.ts';

export type ValidationExpectation = { outcome: 'accept' } | { outcome: 'reject'; code: string };

export type ValidationCase = {
  /** CLI argv vector or Maestro flow source, depending on the target. */
  payload: string[] | string;
  /** Which generator rule produced the case — names the finding and the calibration row. */
  mutation: string;
  expect: ValidationExpectation;
};

export function encodeValidationCase(validationCase: ValidationCase): string {
  return JSON.stringify(validationCase);
}

/** A pinned case the parser must accept. */
export function acceptCase(payload: ValidationCase['payload']): string {
  return encodeValidationCase({ payload, mutation: 'valid', expect: { outcome: 'accept' } });
}

/**
 * A pinned case the parser must refuse with `code`. Seeds run verbatim before any generated case,
 * which is where rules whose whole input space is a few strings belong (#1781 B2).
 */
export function rejectCase(
  payload: ValidationCase['payload'],
  mutation: string,
  code = 'INVALID_ARGS',
): string {
  return encodeValidationCase({ payload, mutation, expect: { outcome: 'reject', code } });
}

/** `null` for anything that is not a well-formed validation envelope. */
export function decodeValidationCase(input: string): ValidationCase | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const { payload, mutation, expect } = parsed as Record<string, unknown>;
  if (typeof mutation !== 'string') return null;
  const validPayload =
    typeof payload === 'string' ||
    (Array.isArray(payload) && payload.every((entry) => typeof entry === 'string'));
  if (!validPayload) return null;
  const expectation = readExpectation(expect);
  if (!expectation) return null;
  return { payload: payload as string[] | string, mutation, expect: expectation };
}

function readExpectation(value: unknown): ValidationExpectation | null {
  if (value === null || typeof value !== 'object') return null;
  const { outcome, code } = value as Record<string, unknown>;
  if (outcome === 'accept') return { outcome: 'accept' };
  if (outcome === 'reject' && typeof code === 'string' && code.length > 0) {
    return { outcome: 'reject', code };
  }
  return null;
}

/**
 * Runs one validation case and judges the outcome against its expectation.
 *
 * The classic rejection invariant still applies (typed AppError, non-empty hint); on top of it:
 * - an input built to be invalid that parses cleanly is a `silent-accept` finding — the #1433
 *   class, invisible to a rejection-only judge;
 * - a rejection with a different `AppError.code` than the generator planted for — or any
 *   rejection of an input built to be valid — is a `wrong-code` finding.
 */
export function judgeValidationCase(
  target: FuzzTargetName,
  input: string,
  validationCase: Pick<ValidationCase, 'mutation' | 'expect'>,
  run: () => void,
): FuzzFailure | null {
  const { mutation, expect } = validationCase;
  try {
    run();
  } catch (error) {
    if (!(error instanceof AppError)) {
      return failure(target, input, 'untyped-throw', `${mutation}: ${describeThrown(error)}`);
    }
    const hint = normalizeError(error).hint;
    if (typeof hint !== 'string' || hint.trim().length === 0) {
      return failure(
        target,
        input,
        'empty-hint',
        `${mutation}: AppError ${error.code} has no hint: ${error.message}`,
      );
    }
    if (expect.outcome === 'accept') {
      return failure(
        target,
        input,
        'wrong-code',
        `${mutation}: expected accept, rejected with ${error.code}: ${error.message}`,
      );
    }
    if (error.code !== expect.code) {
      return failure(
        target,
        input,
        'wrong-code',
        `${mutation}: expected ${expect.code}, got ${error.code}: ${error.message}`,
      );
    }
    return null;
  }
  if (expect.outcome === 'reject') {
    return failure(
      target,
      input,
      'silent-accept',
      `${mutation}: expected ${expect.code}, parser accepted the input`,
    );
  }
  return null;
}

/**
 * Wraps a payload runner as a target `check`. A malformed envelope is a harness or corpus
 * defect, not a parser bug, but it must still surface red rather than crash the run.
 */
export function makeValidationCheck(
  target: FuzzTargetName,
  runPayload: (payload: string[] | string) => void,
): (input: string) => FuzzFailure | null {
  return (input) => {
    const validationCase = decodeValidationCase(input);
    if (!validationCase) {
      return failure(target, input, 'untyped-throw', 'malformed validation case envelope');
    }
    return judgeValidationCase(target, input, validationCase, () =>
      runPayload(validationCase.payload),
    );
  };
}

function failure(
  target: FuzzTargetName,
  input: string,
  kind: FuzzFailure['kind'],
  detail: string,
): FuzzFailure {
  return { target, input, kind, detail };
}
