import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  buildRunnerResponseError,
  decodeRunnerResponseBody,
  isRunnerResponseOk,
  readRunnerResponseData,
} from '../runner-contract.ts';
import { isStructuredRunnerFailure } from '../runner-error-classification.ts';
import { parseRunnerResponse } from '../runner-session.ts';
import type { RunnerSessionState } from '../runner-session-types.ts';

// A body cut off mid-write: the shape a runner that died while answering leaves behind.
const TRUNCATED_BODY = '{"ok":true,"data":{"nodes":[{"label":"Sign In"';
// `ok` is a Swift `Bool`, so this is what a private truthiness rule used to accept as an answer.
const STRINGLY_TYPED_BODY = '{"ok":"true","data":{"tapped":true}}';

describe('decodeRunnerResponseBody', () => {
  test('decodes the runner envelope', () => {
    assert.deepEqual(decodeRunnerResponseBody('{"ok":true,"data":{"tapped":true}}'), {
      ok: true,
      data: { tapped: true },
    });
  });

  test('rejects a truncated body instead of reading a reply out of it', () => {
    assert.throws(
      () => decodeRunnerResponseBody(TRUNCATED_BODY),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'COMMAND_FAILED' &&
        error.message === 'Invalid runner response' &&
        error.details?.text === TRUNCATED_BODY,
    );
  });

  test('refuses a JSON body that is not an envelope instead of inventing one', () => {
    // A JSON scalar is not something the runner's encoder emits. Reading it as an empty reply would
    // count as an answer and discharge a command the runner may still be executing.
    for (const body of ['null', '42', '"ok"']) {
      assert.throws(
        () => decodeRunnerResponseBody(body),
        (error: unknown) =>
          error instanceof AppError && error.message === 'Invalid runner response',
        body,
      );
    }
  });

  test('refuses a bare-array body for the same reason', () => {
    assert.throws(
      () => decodeRunnerResponseBody('[]'),
      (error: unknown) => error instanceof AppError && error.message === 'Invalid runner response',
    );
  });
});

describe('isRunnerResponseOk', () => {
  test('accepts only the boolean true the runner sends', () => {
    assert.equal(isRunnerResponseOk({ ok: true }), true);
    assert.equal(isRunnerResponseOk({ ok: false }), false);
    assert.equal(isRunnerResponseOk({}), false);
    // Stringly-typed truthiness would let a proxy or a wedged socket answer for the runner.
    assert.equal(isRunnerResponseOk({ ok: 'true' }), false);
    assert.equal(isRunnerResponseOk({ ok: 1 }), false);
  });
});

describe('readRunnerResponseData', () => {
  test('reads only an object data payload', () => {
    assert.deepEqual(readRunnerResponseData({ ok: true, data: { tapped: true } }), {
      tapped: true,
    });
    assert.deepEqual(readRunnerResponseData({ ok: true }), {});
    assert.deepEqual(readRunnerResponseData({ ok: true, data: null }), {});
    assert.deepEqual(readRunnerResponseData({ ok: true, data: [] }), {});
    assert.deepEqual(readRunnerResponseData({ ok: true, data: 'tapped' }), {});
  });
});

describe('buildRunnerResponseError', () => {
  test('carries the payload, the runner hint, and the classified code', () => {
    const error = buildRunnerResponseError(
      {
        ok: false,
        error: {
          code: 'RUNNER_BUSY',
          message: 'Main thread is busy',
          hint: 'Retry after it drains',
        },
      },
      '/tmp/runner.log',
    );

    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(error.message, 'Main thread is busy');
    assert.equal(error.details?.hint, 'Retry after it drains');
    assert.equal(error.details?.logPath, '/tmp/runner.log');
    assert.equal(error.details?.retriable, true);
    assert.deepEqual((error.details as { runner?: unknown }).runner, {
      ok: false,
      error: { code: 'RUNNER_BUSY', message: 'Main thread is busy', hint: 'Retry after it drains' },
    });
  });

  test('keeps a missing runner message as a generic runner error', () => {
    const error = buildRunnerResponseError({ ok: false, error: {} });
    assert.equal(error.message, 'Runner error');
    assert.equal(error.details?.hint, undefined);
  });
});

describe('parseRunnerResponse', () => {
  test('refuses a body whose ok is not the boolean true', async () => {
    const session: { state: RunnerSessionState } = { state: 'starting' };

    await assert.rejects(
      () => parseRunnerResponse(new Response(STRINGLY_TYPED_BODY), session),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.deepEqual(error.details?.runner, { ok: 'true', data: { tapped: true } });
        return true;
      },
    );

    assert.equal(session.state, 'starting');
  });

  test('refuses a body that is not readable JSON', async () => {
    const session: { state: RunnerSessionState } = { state: 'starting' };

    await assert.rejects(
      () => parseRunnerResponse(new Response(TRUNCATED_BODY), session),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.equal(error.details?.text, TRUNCATED_BODY);
        // Transport-shaped: no `runner` detail, so the session keeps its recency bets (#2552).
        assert.equal(error.details?.runner, undefined);
        return true;
      },
    );

    assert.equal(session.state, 'starting');
  });

  test('reads a JSON scalar body as transport-shaped, not as an empty reply', async () => {
    // The chain #2965 turns on: an error carrying a `runner` detail counts as an answer and discharges
    // the command's charge. A bare `null` is not an envelope the runner's encoder emits, so decoding it
    // into `{}` and erroring from that would have answered a command the runner may still be running.
    const session: { state: RunnerSessionState } = { state: 'starting' };

    await assert.rejects(
      () => parseRunnerResponse(new Response('null'), session),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.message, 'Invalid runner response');
        assert.equal(error.details?.runner, undefined);
        assert.equal(isStructuredRunnerFailure(error), false);
        return true;
      },
    );

    assert.equal(session.state, 'starting');
  });
});
