import { test, expect, vi, beforeEach } from 'vitest';

// ADR 0014 (evidence #13): Android blocking-dialog recovery is device-mutating
// and expires the frame at its own seam. A ref action admitted against the
// pre-recovery frame must ABORT after recovery mutates — it cannot continue
// against the recovered UI — and the rejection must use the SHARED admission
// shape (reason + ref + currentGeneration + scope), not a bespoke error.

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../interaction-snapshot.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../interaction-snapshot.ts')>();
  return {
    ...actual,
    captureSnapshotForSession: vi.fn(async () => ({ nodes: [], createdAt: 0, backend: 'android' })),
  };
});

// Simulate recovery: the before-command readiness check taps a blocking dialog
// (a device mutation) and reports `recovered`, expiring the frame.
vi.mock('../../android-system-dialog.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../android-system-dialog.ts')>();
  const { expireRefFrame } = await import('../../ref-frame.ts');
  return {
    ...actual,
    ensureAndroidBlockingSystemDialogReady: vi.fn(
      async (params: { session: import('../../types.ts').SessionState; phase: string }) => {
        if (params.phase === 'before-command') {
          expireRefFrame(params.session);
          return { status: 'recovered', warning: 'Recovered from a blocking system dialog' };
        }
        return { status: 'clear' };
      },
    ),
  };
});

import { handleInteractionCommands } from '../interaction.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { attachRefs } from '../../../kernel/snapshot.ts';
import { makeAndroidSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const contextFromFlags = () => ({});

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
});

test('a ref action aborts with the shared ref_frame_expired rejection after Android dialog recovery mutates', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-recovery-abort';
  const session = makeAndroidSession(sessionName);
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 80, height: 80 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'android',
  };
  session.snapshotGeneration = 900;
  // A freshly issued complete frame is active.
  sessionStore.set(sessionName, session);

  const response = await handleInteractionCommands({
    req: { token: 't', session: sessionName, command: 'press', positionals: ['@e1'], flags: {} },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('COMMAND_FAILED');
    // The SHARED admission rejection shape — not a bespoke recovery error.
    const details = response.error.details as Record<string, unknown> | undefined;
    expect(details?.reason).toBe('ref_frame_expired');
    expect(details?.ref).toBe('@e1');
    expect(details?.currentGeneration).toBe(900);
    expect(details?.scope).toBe('all');
  }
  // The outstanding ref action never dispatched a press against the recovered UI.
  expect(mockDispatch.mock.calls.some((call) => call[1] === 'press')).toBe(false);
});
