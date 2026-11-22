import { SessionCoordinator } from '../../../../core/session-store.ts';
import path from 'node:path';
import { expect, test } from 'vitest';
import { completeOpenCommand } from '../session-open-execution.ts';
import { openApplicationRuntimeUse } from '@agent-device/contracts/application-lifecycle-runtime-plan';
import { resolveExistingSessionDeviceSelection } from '@agent-device/device-selection/device-selection-resolver';
import { mockBindDeviceRuntime } from '../../../../__tests__/support/handlers/session-command-harness.ts';
import { lifecycleOperationsSpy } from '../../../../__tests__/support/lifecycle-operations-spy.ts';
import {
  makeAndroidEmulator,
  makeSession,
  makeSessionStore,
} from './session-open-runtime.fixtures.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  registerRequestAbort,
  markRequestCanceled,
  clearRequestAbortRegistration,
} from '@agent-device/host-kit/request';

test.each([
  { fails: false, priorBoot: undefined },
  { fails: true, priorBoot: undefined },
  { fails: false, priorBoot: true },
  { fails: true, priorBoot: true },
] as const)(
  'reopen preserves boot ownership with a stale device snapshot (fails: $fails, owned: $priorBoot)',
  async ({ fails, priorBoot }) => {
    const store = makeSessionStore();
    const device = { ...makeAndroidEmulator(), booted: false };
    const ref = store.publish('reopen', {
      ...makeSession('reopen', device),
      bootedByOpen: priorBoot,
    });
    const { loader } = lifecycleOperationsSpy({
      openApplication: async () => {
        expect(store.requireCurrent(ref).bootedByOpen).toBe(priorBoot);
        if (fails) throw new AppError('COMMAND_FAILED', 'Launch rejected');
        return { timing: {} };
      },
    });
    const pending = completeOpenCommand({
      req: { token: 't', command: 'open', positionals: [], session: 'reopen' },
      sessionName: 'reopen',
      sessionStore: store,
      logPath: path.join(store.host.cwd, 'daemon.log'),
      device,
      openPositionals: [],
      surface: 'app',
      runtimeHints: undefined,
      existingRef: ref,
      selection: resolveExistingSessionDeviceSelection(device),
      lifecycle: await mockBindDeviceRuntime(device, openApplicationRuntimeUse, undefined, loader),
    });
    if (fails) await expect(pending).rejects.toThrow('Launch rejected');
    else expect((await pending).type).toBe('opened');
    expect(store.requireCurrent(ref).bootedByOpen).toBe(priorBoot);
  },
);

test.each(['recording', 'launch', 'cancel'] as const)(
  'provisional cold open retains its boot after %s failure',
  async (failure) => {
    const store = makeSessionStore();
    const device = { ...makeAndroidEmulator(), booted: false };
    const requestId = `provisional-boot-${failure}`;
    const registration = registerRequestAbort(requestId);
    const { loader } = lifecycleOperationsSpy({
      openApplication: async () => {
        if (failure === 'launch') throw new AppError('COMMAND_FAILED', 'Launch rejected');
        markRequestCanceled(requestId);
        return { timing: {} };
      },
    });
    try {
      const pending = completeOpenCommand({
        req: {
          token: 't',
          command: 'open',
          positionals: [],
          session: 'provisional',
          meta: { requestId },
          internal: {
            openSlot: new SessionCoordinator(store).reserve(
              {
                token: 't',
                command: 'open',
                session: 'provisional',
                positionals: [],
                meta: { requestId },
              },
              'provisional',
            ),
            openLifecycle: {
              beforeDispatch: async () => {
                if (failure === 'recording')
                  return {
                    ok: false,
                    error: { code: 'COMMAND_FAILED', message: 'Recording rejected' },
                  };
              },
            },
          },
        },
        sessionName: 'provisional',
        sessionStore: store,
        logPath: path.join(store.host.cwd, 'daemon.log'),
        device,
        openPositionals: [],
        surface: 'app',
        runtimeHints: undefined,
        selection: {
          device,
          source: 'local',
          reason: 'single-bootable-local',
          candidateCount: 1,
          bootOccurred: false,
        },
        lifecycle: await mockBindDeviceRuntime(
          device,
          openApplicationRuntimeUse,
          undefined,
          loader,
        ),
      });
      if (failure === 'launch') await expect(pending).rejects.toThrow('Launch rejected');
      else expect(await pending).toMatchObject({ type: 'response', response: { ok: false } });
      expect(store.get('provisional')?.bootedByOpen).toBe(true);
    } finally {
      clearRequestAbortRegistration(registration);
    }
  },
);
