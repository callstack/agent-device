import { describe, expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  scrubPublishedError,
  withInstanceCredentialScrubbing,
} from './instance-error-scrubbing.ts';

const TOKEN = 'liminst_c0ffee';
const SENT = [`Bearer ${TOKEN}`];

type FakeClient = {
  fails: () => Promise<never>;
  answers: () => Promise<string>;
  throwsNow: () => never;
  state: { disconnect(): void };
  count: number;
};

function fakeClient(options: { rejectWith: unknown }): FakeClient {
  return {
    fails: async () => {
      throw options.rejectWith;
    },
    answers: async () => 'two apps installed',
    throwsNow: () => {
      throw new Error(`synchronous ${TOKEN}`);
    },
    state: { disconnect: () => {} },
    count: 1,
  };
}

// The instance client's failures are the peer's own text — a rejected frame, or a reply body — and this
// session authenticated the channel with the instance token, which an instance echoes as a bare value.
test.each([
  ['a raw Error naming the token', new Error(`frame rejected: ${TOKEN}`)],
  [
    'an AppError whose details name the token',
    new AppError('COMMAND_FAILED', `install refused for ${TOKEN}`, {
      reply: `token ${TOKEN} is not valid here`,
      attempt: 2,
      nested: { text: `${TOKEN}` },
    }),
  ],
])('an instance command failure is published without the credential: %s', async (_name, error) => {
  const client = withInstanceCredentialScrubbing(fakeClient({ rejectWith: error }), SENT);

  let failure: unknown;
  await client.fails().catch((error: unknown) => {
    failure = error;
  });

  expect(failure).toBeInstanceOf(Error);
  const published = failure as { message: string; details?: unknown };
  expect(published.message).toMatch(/rejected|refused/);
  expect(JSON.stringify({ message: published.message, details: published.details })).not.toContain(
    TOKEN,
  );
});

test('a method that answers normally is passed through untouched', async () => {
  const client = withInstanceCredentialScrubbing(fakeClient({ rejectWith: new Error('x') }), SENT);

  await expect(client.answers()).resolves.toBe('two apps installed');
});

// A failure that names nothing this session sent is the command's own to answer for: the caller that
// caught it publishes its own reason and its own cause, so the wrapper must not answer first.
test('a rejection that names no sent value keeps its own failure', async () => {
  const cause = new Error('SDK sync refused');
  const client = withInstanceCredentialScrubbing(fakeClient({ rejectWith: cause }), SENT);

  await expect(client.fails()).rejects.toBe(cause);
});

test('an AppError that names no sent value keeps its own code, details and cause', async () => {
  const cause = new Error('device busy');
  const failure = new AppError(
    'COMMAND_FAILED',
    'the instance is busy',
    {
      reason: 'limrun_app_sync_failed',
      platform: 'ios',
    },
    cause,
  );
  const client = withInstanceCredentialScrubbing(fakeClient({ rejectWith: failure }), SENT);

  await expect(client.fails()).rejects.toBe(failure);
});

test('a non-function member is read through unchanged', () => {
  const client = withInstanceCredentialScrubbing(fakeClient({ rejectWith: new Error('x') }), SENT);

  expect(client.count).toBe(1);
  expect(typeof client.state).toBe('object');
});

// A synchronous throw happens before any request was made, so the call keeps the SDK's own error and the
// caller's own control flow.
test('a method that throws before a request was made keeps its own failure', () => {
  const client = withInstanceCredentialScrubbing(fakeClient({ rejectWith: new Error('x') }), SENT);

  expect(() => client.throwsNow()).toThrow(TOKEN);
});

describe('scrubPublishedError', () => {
  test('removes a credential from a published message and every detail string', () => {
    const failure = new AppError('COMMAND_FAILED', `the runner failed for ${TOKEN}`, {
      text: `401 Unauthorized: ${TOKEN}`,
      statusCode: 401,
      paths: ['Runner.xctestrun', TOKEN],
    });

    const scrubbed = scrubPublishedError(failure, SENT) as AppError;

    expect(scrubbed).toBeInstanceOf(AppError);
    expect(scrubbed.code).toBe('COMMAND_FAILED');
    expect(scrubbed.details?.statusCode).toBe(401);
    expect(scrubbed.details?.paths).toEqual(['Runner.xctestrun', '[REDACTED]']);
    expect(JSON.stringify({ message: scrubbed.message, details: scrubbed.details })).not.toContain(
      TOKEN,
    );
  });

  test('answers with the same error when nothing it publishes names a sent value', () => {
    const failure = new AppError('COMMAND_FAILED', 'the runner exited early', { statusCode: 500 });

    expect(scrubPublishedError(failure, SENT)).toBe(failure);
  });

  test('passes a failure this plugin did not build through unchanged', () => {
    const failure = new TypeError(`bad url ${TOKEN}`);

    expect(scrubPublishedError(failure, SENT)).toBe(failure);
  });

  test('is a no-op when no credential was sent', () => {
    const failure = new AppError('COMMAND_FAILED', `mentions ${TOKEN}`, { text: TOKEN });

    expect(scrubPublishedError(failure, [])).toBe(failure);
  });

  // A cause is published as text too: the CLI prints `Cause: <code> <message>`. An AppError cause's own
  // details are not published, so the rebuild keeps its code and its scrubbed message.
  test('removes a credential from a cause the failure carries', () => {
    const failure = new AppError(
      'COMMAND_FAILED',
      'the runner refused the command',
      { reason: 'limrun_runner_upload_failed' },
      new AppError('COMMAND_FAILED', `refused: ${TOKEN}`, { response: `401 ${TOKEN}` }),
    );

    const scrubbed = scrubPublishedError(failure, SENT) as AppError;

    expect(scrubbed.cause).toBeInstanceOf(AppError);
    const cause = scrubbed.cause as AppError;
    expect(cause.code).toBe('COMMAND_FAILED');
    expect(cause.message).toBe('refused: [REDACTED]');
    expect(cause.details).toBeUndefined();
  });

  test('a cause that names no sent value is the same object', () => {
    const cause = new AppError('COMMAND_FAILED', 'the instance exited early');
    const failure = new AppError('COMMAND_FAILED', `refused: ${TOKEN}`, {}, cause);

    expect((scrubPublishedError(failure, SENT) as AppError).cause).toBe(cause);
  });
});

test('drops nested diagnostic properties whose names contain the instance token', () => {
  const failure = new AppError('COMMAND_FAILED', 'runner refused', {
    runner: { status: 401, ['echo-' + TOKEN]: 'unexpected' },
  });
  expect(scrubPublishedError(failure, SENT)).toMatchObject({
    details: { runner: { status: 401 } },
  });
  expect(JSON.stringify(scrubPublishedError(failure, SENT))).not.toContain(TOKEN);
});
