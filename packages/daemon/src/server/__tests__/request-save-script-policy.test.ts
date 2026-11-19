/**
 * #1478 (P4-pre): `flags.saveScript` is accepted only on the released
 * `--save-script` flag owners. Everything else is rejected at the daemon
 * request seam before any admission, session, or device work.
 */
import path from 'node:path';
import { expect, test } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  ANDROID_EMULATOR,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { makeAuthoringSession } from '../../__tests__/support/session-factories.ts';
import {
  createLifecycleDeviceRuntimeGatewaySpies,
  createRequestHandler,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { SessionStore } from '../../core/session-store.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  listSaveScriptFlagOwnerCommands,
  ownsSaveScriptFlag,
} from '../../core/daemon-command-registry.ts';
import {
  SAVE_SCRIPT_FLAG_OWNER_COMMANDS,
  saveScriptFlagResponse as checkSaveScriptFlag,
} from '../request-save-script-policy.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';

function request(command: string, flags: DaemonRequest['flags']): DaemonRequest {
  return { token: 'token', session: 'default', command, positionals: [], flags };
}

function saveScriptFlagResponse(req: DaemonRequest) {
  return checkSaveScriptFlag(req, process.cwd());
}

test('the flag owners are exactly the released open/close/replay surface', () => {
  expect(listSaveScriptFlagOwnerCommands()).toEqual(['close', 'open', 'replay']);
  expect(SAVE_SCRIPT_FLAG_OWNER_COMMANDS).toEqual(['close', 'open', 'replay']);
  for (const command of SAVE_SCRIPT_FLAG_OWNER_COMMANDS) {
    expect(ownsSaveScriptFlag(command)).toBe(true);
  }
  // `test` runs replay scripts but never declares `--save-script`, and the
  // internal publication command carries its path/force as positionals+flags of
  // its own — neither may arm through the raw flag.
  expect(ownsSaveScriptFlag('test')).toBe(false);
  expect(ownsSaveScriptFlag('session_save_script')).toBe(false);
});

test('owner commands and flag-free requests pass the seam untouched', () => {
  for (const command of SAVE_SCRIPT_FLAG_OWNER_COMMANDS) {
    expect(saveScriptFlagResponse(request(command, { saveScript: true }))).toBe(undefined);
    expect(saveScriptFlagResponse(request(command, { saveScript: './flow.ad' }))).toBe(undefined);
  }
  expect(saveScriptFlagResponse(request('record', {}))).toBe(undefined);
  expect(saveScriptFlagResponse(request('record', undefined))).toBe(undefined);
});

test.each(['record', 'trace', 'click', 'fill', 'snapshot', 'test', 'session_save_script'])(
  'raw saveScript on %s is rejected with an ADR 0010 shaped INVALID_ARGS error',
  (command) => {
    const response = saveScriptFlagResponse(request(command, { saveScript: true }));

    expect(response?.ok).toBe(false);
    if (!response || response.ok) return;
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toBe('--save-script is supported only by close, open, replay.');
    // The per-code default hint ("check command arguments") would misdirect, so
    // the rejection names the surfaces that actually publish a script.
    expect(response.error.hint).toMatch(/session save-script/);
  },
);

test('presence is rejected, not truthiness — a raw false is unsupported too', () => {
  const response = saveScriptFlagResponse(request('record', { saveScript: false }));

  expect(response?.ok).toBe(false);
  if (!response || response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
});

test.each(['./missing/.', 'missing/..', '~/'])(
  'an owner path spelled %s is refused at the seam before the daemon expands it',
  (spelled) => {
    const response = saveScriptFlagResponse(request('open', { saveScript: spelled }));

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        details: { reason: 'script_ancestor_untrusted', exposure: 'unnamed_entry' },
      },
    });
  },
);

test.each([String.raw`\\localhost\pipe\recorder`])(
  'a local owner path in the Windows pipe namespace %s is refused at the seam',
  (spelled) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(
        saveScriptFlagResponse(request('open', { saveScript: spelled, force: true })),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_ARGS',
          details: { reason: 'script_ancestor_untrusted', exposure: 'windows_path_form' },
        },
      });
    } finally {
      Object.defineProperty(process, 'platform', original!);
    }
  },
);

test.each([
  { command: 'open', saveScript: '\\journey.ad' },
  { command: 'open', saveScript: '\\\\?\\C:\\journey.ad' },
  { command: 'close', saveScript: '\\journey.ad' },
  { command: 'close', saveScript: '\\\\?\\C:\\journey.ad' },
])('$command refuses $saveScript before backend work', async ({ command, saveScript }) => {
  const directory = mkdtempForTestSync('daemon-save-script-admission-');
  const host = createTestHostEnvironment({ cwd: 'C:\\work' });
  const sessionStore = new SessionStore(path.join(directory, 'sessions'), host);
  const session =
    command === 'close' ? makeAuthoringSession('default', { device: ANDROID_EMULATOR }) : undefined;
  if (session) sessionStore.publish('default', session);
  const { gateway, inspectFacts, bind } = createLifecycleDeviceRuntimeGatewaySpies();
  const handler = createRequestHandler({
    host,
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(directory, 'daemon.log'),
    token: 'token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: gateway,
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async () => [ANDROID_EMULATOR],
    }),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const response = await handler({
      ...request(command, { platform: 'android', saveScript }),
      positionals: command === 'open' ? ['com.example.app'] : [],
    });
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_ARGS',
        details: { reason: 'script_ancestor_untrusted', exposure: 'windows_path_form' },
      },
    });
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  expect(inspectFacts).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
  expect(sessionStore.get('default')).toBe(session);
});
