import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  buildRunnerResponseError,
  decodeRunnerResponseBody,
  isRunnerResponseOk,
  readRunnerResponseData,
} from '../runner-contract.ts';

// A body cut off mid-write: the shape a runner that died while answering leaves behind.
const TRUNCATED_BODY = '{"ok":true,"data":{"nodes":[{"label":"Sign In"';

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

  test('passes a runner diagnostic through without letting it stamp the dispatch verdict', () => {
    const error = buildRunnerResponseError({
      ok: false,
      error: {
        code: 'ALERT_NOT_FOUND',
        message: 'alert not found',
        hint: 'Inspect the surface',
        details: {
          nearMisses: [
            {
              type: 'Other',
              identifier: 'SFDialogView',
              label: 'Open this page?',
              buttons: ['Cancel', 'Open'],
            },
          ],
          dispatched: 'yes',
        },
      },
    });

    assert.deepEqual(error.details?.nearMisses, [
      {
        type: 'Other',
        identifier: 'SFDialogView',
        label: 'Open this page?',
        buttons: ['Cancel', 'Open'],
      },
    ]);
    assert.equal(error.details?.runnerErrorCode, 'ALERT_NOT_FOUND');
    assert.equal(error.details?.dispatched, 'no');
    // `runner` carries the same payload, so the two paths must not be one object: diagnostics print
    // an object reachable twice as `[Circular]`.
    const shared = (error.details as { runner: { error: { details: { nearMisses: unknown } } } })
      .runner.error.details.nearMisses;
    assert.notStrictEqual(error.details?.nearMisses, shared);
  });

  test('ignores a runner diagnostic that is not an object', () => {
    const error = buildRunnerResponseError({
      ok: false,
      error: { code: 'ALERT_NOT_FOUND', message: 'alert not found', details: 'SFDialogView' },
    });
    assert.equal(error.details?.nearMisses, undefined);
  });

  test('withholds the classification keys a runner tries to stamp for a code that sets neither', () => {
    // ALERT_NOT_FOUND classifies with no reason and no retriable, so both keys on the wire are the
    // runner's invention and must not reach the caller.
    const error = buildRunnerResponseError({
      ok: false,
      error: {
        code: 'ALERT_NOT_FOUND',
        message: 'alert not found',
        details: { reason: 'runnerCrashed', retriable: true, nearMisses: [] },
      },
    });
    assert.equal('reason' in (error.details ?? {}), false);
    assert.equal('retriable' in (error.details ?? {}), false);
    assert.deepEqual(error.details?.nearMisses, []);
  });
});
