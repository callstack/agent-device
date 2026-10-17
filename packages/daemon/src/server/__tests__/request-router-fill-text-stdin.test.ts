/**
 * #3260: `fill --text-stdin` keeps the value out of argv, so it must not come back on the
 * response either, and neither may a replayed `--record-as` value. Sent through the real request
 * handler to a web session, the narrowest runtime that still runs the full fill admission,
 * dispatch and response projection.
 */
import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  localRuntimeOwner,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { FillPointInput } from '@agent-device/contracts/touch-runtime';
import {
  createUnavailableRuntimeFactsForTest,
  mkdtempForTestSync,
  WEB_DESKTOP_DEVICE,
} from '@agent-device/test-kit';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { SessionState } from '../../core/session-state.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { makeAuthoringSession, makeSession } from '../../__tests__/support/session-factories.ts';
import { createTouchCommandSurface } from '../../__tests__/support/touch-command-surface-fake.ts';
import { replayScriptSourceBundleFor } from '../../__tests__/support/replay-script-source-fixture.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';

const SECRET = 'stdin-s3cret-value';

function fillWithStdinText(
  session: SessionState,
  flags: Record<string, unknown> = {},
  fillFails?: (text: string) => Error,
  text = SECRET,
) {
  return sendToWebSession(
    session,
    { command: 'fill', positionals: ['10', '20', text], flags: { textStdin: true, ...flags } },
    fillFails,
  );
}

function sendToWebSession(
  session: SessionState,
  request: Pick<DaemonRequest, 'command' | 'positionals' | 'flags'>,
  fillFails?: (text: string) => Error,
) {
  const sessionStore = makeSessionStore('agent-device-router-fill-text-stdin-');
  sessionStore.publish(session.name, session);
  const typed: string[] = [];
  const fillPoint = async (input: FillPointInput) => {
    typed.push(input.text);
    if (fillFails) throw fillFails(input.text);
  };
  const owner = localRuntimeOwner('web');
  const baseFacts = createUnavailableRuntimeFactsForTest(WEB_DESKTOP_DEVICE, owner);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    ...baseFacts,
    operations: { ...baseFacts.operations, fillPoint: { available: true } },
  };
  const deviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: async () => facts,
    bind: async ({ device }) => {
      const binding: DeviceBinding<PlatformRuntimeOperations> = {
        device,
        owner,
        facts,
        operations: { fillPoint },
        [Symbol.asyncDispose]: async () => {},
      };
      return binding;
    },
    shutdown: async () => {},
  };
  const dir = mkdtempForTestSync('agent-device-router-fill-text-stdin-runtime-');
  const handler = createRequestHandler({
    createCommandSurface: createTouchCommandSurface(),
    logPath: path.join(dir, 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway,
    trackDownloadableArtifact: () => 'artifact-id',
  });
  const response = handler({
    token: 'test-token',
    session: session.name,
    ...request,
    meta: { requestId: 'req-fill-text-stdin' },
  });
  return { response, typed, sessionStore };
}

test('an unrecorded --text-stdin fill types the value but returns no part of it', async () => {
  const { response, typed } = fillWithStdinText(makeSession('web', { device: WEB_DESKTOP_DEVICE }));

  const result = await response;
  expect(result.ok).toBe(true);
  expect(typed).toEqual([SECRET]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
  if (result.ok) expect(result.data?.text).toBe('[REDACTED]');
});

test('an armed --text-stdin --no-record fill returns no part of the value and records nothing', async () => {
  const session = makeAuthoringSession('web', { device: WEB_DESKTOP_DEVICE });
  const { response, typed, sessionStore } = fillWithStdinText(session, { noRecord: true });

  const result = await response;
  expect(result.ok).toBe(true);
  expect(typed).toEqual([SECRET]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
  if (result.ok) expect(result.data?.text).toBe('[REDACTED]');
  expect(sessionStore.get('web')?.actions).toEqual([]);
});

test('an armed --text-stdin fill without --record-as or --no-record is refused before typing', async () => {
  const session = makeAuthoringSession('web', { device: WEB_DESKTOP_DEVICE });
  const { response, typed } = fillWithStdinText(session);

  const result = await response;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('INVALID_ARGS');
  expect(result.error.details?.reason).toBe('fill_text_stdin_unparameterized_recording');
  expect(typed).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

test.each([
  ['recordAs', { textStdin: undefined, recordAs: 42 }, '--record-as'],
  ['textStdin', { textStdin: 'true' }, '--text-stdin'],
])(
  'a fill whose %s marker has the wrong type is refused before typing',
  async (_name, flags, flagName) => {
    const { response, typed } = fillWithStdinText(
      makeSession('web', { device: WEB_DESKTOP_DEVICE }),
      flags,
    );

    const result = await response;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_ARGS');
    expect(result.error.message).toContain(flagName);
    expect(typed).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  },
);

test('a backend error that echoes the --text-stdin value does not return it', async () => {
  const { response, typed } = fillWithStdinText(
    makeSession('web', { device: WEB_DESKTOP_DEVICE }),
    {},
    (text) => new Error(`could not type "${text}" into the field`),
  );

  const result = await response;
  expect(result.ok).toBe(false);
  expect(typed).toEqual([SECRET]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
  if (!result.ok) expect(result.error.message).toBe('could not type "[REDACTED]" into the field');
});

test('a backend error that echoes a --record-as stdin value shows its placeholder', async () => {
  const { response, typed } = fillWithStdinText(
    makeAuthoringSession('web', { device: WEB_DESKTOP_DEVICE }),
    { recordAs: 'PASSWORD' },
    (text) => new Error(`could not type "${text}" into the field`),
  );

  const result = await response;
  expect(result.ok).toBe(false);
  expect(typed).toEqual([SECRET]);
  if (!result.ok) expect(result.error.message).toBe('could not type "${PASSWORD}" into the field');
});

test.each([
  ['an unrecorded', 'abc[REDACTED]xyz', {}, '[REDACTED]', makeSession],
  [
    'a --record-as',
    'abc${PASSWORD}xyz',
    { recordAs: 'PASSWORD' },
    '${PASSWORD}',
    makeAuthoringSession,
  ],
])(
  '%s --text-stdin value that contains its own placeholder is returned by neither a success nor an error',
  async (_name, secret, flags, placeholder, sessionFor) => {
    const filled = fillWithStdinText(
      sessionFor('web', { device: WEB_DESKTOP_DEVICE }),
      flags,
      undefined,
      secret,
    );
    const failed = fillWithStdinText(
      sessionFor('web', { device: WEB_DESKTOP_DEVICE }),
      flags,
      (text) => new Error(`could not type "${text}" into the field`),
      secret,
    );

    const succeeded = await filled.response;
    const errored = await failed.response;
    expect(filled.typed).toEqual([secret]);
    expect(failed.typed).toEqual([secret]);
    expect(succeeded.ok).toBe(true);
    expect(JSON.stringify(succeeded)).not.toContain(secret);
    expect(JSON.stringify(filled.sessionStore.get('web')?.actions ?? [])).not.toContain(secret);
    expect(errored.ok).toBe(false);
    expect(JSON.stringify(errored)).not.toContain(secret);
    if (!errored.ok) expect(errored.error.message).toBe(placeholder);
  },
);

test('a short --text-stdin value is redacted from the error text but not from its log path', async () => {
  // `stdin` also appears in this request's id, which names its diagnostics file.
  const { response } = fillWithStdinText(
    makeSession('web', { device: WEB_DESKTOP_DEVICE }),
    {},
    (text) => new Error(`could not type "${text}" into the field`),
    'stdin',
  );

  const result = await response;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toBe('could not type "[REDACTED]" into the field');
  expect(result.error.logPath).toContain('req-fill-text-stdin');
  expect(fs.existsSync(result.error.logPath!)).toBe(true);
  expect(result.error.diagnosticsRecord?.requestId).toBe('req-fill-text-stdin');
});

test('a batch step carrying --text-stdin is refused before typing and returns no part of the value', async () => {
  const { response, typed } = sendToWebSession(makeSession('web', { device: WEB_DESKTOP_DEVICE }), {
    command: 'batch',
    positionals: [],
    flags: {
      batchSteps: [
        { command: 'fill', positionals: ['10', '20', SECRET], flags: { textStdin: true } },
      ],
    },
  });

  const result = await response;
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe('INVALID_ARGS');
  expect(result.error.details?.reason).toBe('fill_text_stdin_in_batch');
  expect(typed).toEqual([]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

test('a replayed --record-as fill whose backend error echoes the value does not return it', async () => {
  const flowPath = path.join(
    mkdtempForTestSync('agent-device-router-replay-record-as-'),
    'flow.ad',
  );
  fs.writeFileSync(flowPath, 'fill 10 20 "${PASSWORD}"\n');
  const { response, typed } = sendToWebSession(
    makeSession('web', { device: WEB_DESKTOP_DEVICE }),
    {
      command: 'replay',
      positionals: [flowPath],
      flags: {
        replayEnv: [`PASSWORD=${SECRET}`],
        replayScriptSource: replayScriptSourceBundleFor(flowPath),
      },
    },
    (text) => new Error(`could not type "${text}" into the field`),
  );

  const result = await response;
  expect(result.ok).toBe(false);
  expect(typed).toEqual([SECRET]);
  expect(JSON.stringify(result)).not.toContain(SECRET);
  if (!result.ok) expect(result.error.message).toContain('could not type "${PASSWORD}"');
});

test('a batch fill step with textStdin false is dispatched like any fill', async () => {
  const { response, typed } = sendToWebSession(makeSession('web', { device: WEB_DESKTOP_DEVICE }), {
    command: 'batch',
    positionals: [],
    flags: {
      batchSteps: [
        { command: 'fill', positionals: ['10', '20', 'plain'], flags: { textStdin: false } },
      ],
    },
  });

  const result = await response;
  expect(result.ok).toBe(true);
  expect(typed).toEqual(['plain']);
});

test('a whitespace-only --text-stdin value collapses the error text it appears in', async () => {
  const { response } = fillWithStdinText(
    makeSession('web', { device: WEB_DESKTOP_DEVICE }),
    {},
    (text) => new Error(`could not type "${text}" into the field`),
    ' ',
  );

  const result = await response;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toBe('[REDACTED]');
});
