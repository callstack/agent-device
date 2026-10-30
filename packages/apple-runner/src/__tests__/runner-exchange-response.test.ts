import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { isStructuredRunnerFailure } from '../runner-error-classification.ts';
import { parseRunnerResponse } from '../runner-exchange.ts';
import type { RunnerSessionState } from '../runner-session-types.ts';

// A body cut off mid-write: the shape a runner that died while answering leaves behind.
const TRUNCATED_BODY = '{"ok":true,"data":{"nodes":[{"label":"Sign In"';
// `ok` is a Swift `Bool`, so this is what a private truthiness rule used to accept as an answer.
const STRINGLY_TYPED_BODY = '{"ok":"true","data":{"tapped":true}}';

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
