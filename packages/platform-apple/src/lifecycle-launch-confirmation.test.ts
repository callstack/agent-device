import { beforeEach, expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { AppError } from '@agent-device/kernel/errors';

import { bindAppleApplicationLifecycle } from './lifecycle.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';
import type { LaunchObservation } from './snapshot-observability.ts';
import { alertNotFound, CONFIRMATION } from './launch-confirmation.fixtures.ts';
import {
  COMING_UP,
  LAUNCH_URL,
  OBSERVABLE,
  SPAWN_TIMEOUT,
  UNOBSERVABLE,
  device,
  launchUrlInput,
  launchUrlSimulator,
  resetUrlOwner,
  urlOwner,
} from './lifecycle.fixtures.ts';

/**
 * Launch-URL open and its SpringBoard confirmation: reading, recognizing, accepting, reporting,
 * and failing it. The host-AX settle around it lives here too because every confirmation case is
 * reached through an unobservable launch verdict.
 */

vi.mock('./core/app-resolution.ts', async () => {
  const fixtures = await import('./lifecycle.fixtures.ts');
  return {
    resolveIosSimulatorDeepLinkBundleId: async () => await fixtures.urlOwner.resolve(),
  };
});

beforeEach(() => {
  resetUrlOwner();
});
test('a launch URL the bridge sees land in the app never reaches the runner', async () => {
  const { lifecycle, events, interactor, releaseSpeculativeRunner, prewarmRunnerSession } =
    launchUrlSimulator(async () => {
      throw alertNotFound();
    });

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome.launchConfirmation).toBeUndefined();
  expect(outcome.timing.runnerDemand).toBe('none');
  expect(releaseSpeculativeRunner).toHaveBeenCalledOnce();
  expect(prewarmRunnerSession).not.toHaveBeenCalled();
  expect(interactor.awaitAlert).not.toHaveBeenCalled();
  expect(events).toEqual(['release', `open ${LAUNCH_URL}`, 'observe observable']);
});

/** Verdicts that prove nothing about whether the app came up, so the sheet is still read. */
const DISCOVERY_DEADLINE_TIMEOUT: LaunchObservation = {
  observation: 'probe-failed',
  failure: { source: 'target', code: 'COMMAND_FAILED' },
};
const TARGET_PROBE_FAILED: LaunchObservation = {
  observation: 'probe-failed',
  failure: {
    source: 'target',
    code: 'COMMAND_FAILED',
    reason: 'simulator-target-probe-failed',
  },
};
const BRIDGE_CIRCUIT: LaunchObservation = {
  observation: 'probe-failed',
  failure: { source: 'circuit' },
};

test.each([
  ['the bridge circuit is open', BRIDGE_CIRCUIT, BRIDGE_CIRCUIT],
  ['target discovery fails on its deadline', DISCOVERY_DEADLINE_TIMEOUT, OBSERVABLE],
  ['the target probe fails outright', TARGET_PROBE_FAILED, OBSERVABLE],
])(
  'a confirmable launch whose bridge verdict is %s still reads and answers the sheet',
  async (_name, beforeAnswer, afterAnswer) => {
    const { lifecycle, events, interactor } = launchUrlSimulator(
      async () => CONFIRMATION,
      [beforeAnswer, afterAnswer],
    );

    const outcome = await lifecycle.openApplication(launchUrlInput());

    expect(outcome.launchConfirmation).toBe('accepted');
    expect(outcome.timing.runnerDemand).toBe('required');
    expect(interactor.awaitAlert).toHaveBeenCalledOnce();
    expect(outcome.timing.postOpenObservation).toBe(afterAnswer.observation);
    // A verdict the bridge could not produce keeps its typed failure, so the open still says why
    // the app came back unreadable.
    expect(outcome.timing.postOpenObservationFailure).toEqual(
      afterAnswer.observation === 'probe-failed' ? afterAnswer.failure : undefined,
    );
    expect(events).toEqual([
      'release',
      `open ${LAUNCH_URL}`,
      'observe probe-failed',
      'alert wait',
      'alert accept',
      `observe ${afterAnswer.observation}`,
    ]);
  },
);

test('a launch URL held behind a confirmation for the session app is accepted and reported', async () => {
  const { lifecycle, events, resolutions } = launchUrlSimulator(
    async () => CONFIRMATION,
    [UNOBSERVABLE, OBSERVABLE],
  );

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome.launchConfirmation).toBe('accepted');
  // One resolution dispatches the open; one more serves both the alert read and the accept.
  expect(resolutions()).toBe(2);
  expect(outcome.timing.runnerDemand).toBe('required');
  expect(outcome.timing.postOpenObservation).toBe('observable');
  expect(events).toEqual([
    'release',
    `open ${LAUNCH_URL}`,
    'observe unobservable',
    'alert wait',
    'alert accept',
    'observe observable',
  ]);
});

test('the reported settle spans both observations and the answer between them', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { lifecycle } = launchUrlSimulator(
      async () => {
        vi.advanceTimersByTime(100);
        return CONFIRMATION;
      },
      [UNOBSERVABLE, OBSERVABLE],
      {
        owner: async () => {
          vi.advanceTimersByTime(100);
          return 'com.example.app';
        },
      },
    );

    const outcome = await lifecycle.openApplication(launchUrlInput());

    expect(outcome.launchConfirmation).toBe('accepted');
    expect(outcome.timing.postOpenSettleDurationMs).toBe(200);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ['finds no alert', alertNotFound(), undefined],
  [
    'cannot reach the runner',
    new AppError('COMMAND_FAILED', 'runner unavailable', { reason: 'runner-start-failed' }),
    'alert-read' as const,
  ],
])(
  'an unobservable launch whose alert read %s returns the open as it was',
  async (_case, failure, probeFailure) => {
    const { lifecycle, events } = launchUrlSimulator(async () => {
      throw failure;
    }, [UNOBSERVABLE]);

    const outcome = await lifecycle.openApplication(launchUrlInput());

    expect(outcome.launchConfirmation).toBeUndefined();
    if (probeFailure) {
      expect(outcome).toMatchObject({ launchConfirmationProbeFailure: probeFailure });
    } else {
      expect('launchConfirmationProbeFailure' in outcome).toBe(false);
    }
    expect(outcome.timing.runnerDemand).toBe('required');
    expect(outcome.timing.postOpenObservation).toBe('unobservable');
    expect(events).toEqual(['release', `open ${LAUNCH_URL}`, 'observe unobservable', 'alert wait']);
  },
);

test('an unobservable launch whose runner interactor cannot be resolved reports the runner step', async () => {
  const { lifecycle, events } = launchUrlSimulator(async () => CONFIRMATION, [UNOBSERVABLE], {
    resolveInteractor: async () => {
      throw SPAWN_TIMEOUT;
    },
  });

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome.launchConfirmation).toBeUndefined();
  expect(outcome).toMatchObject({ launchConfirmationProbeFailure: 'runner' });
  expect(outcome.timing.postOpenObservation).toBe('unobservable');
  expect(events).toEqual(['release', `open ${LAUNCH_URL}`, 'observe unobservable']);
});

test('a prompt whose URL owner lookup fails reports the unanswered confirmation', async () => {
  const { lifecycle, interactor } = launchUrlSimulator(async () => CONFIRMATION, [UNOBSERVABLE], {
    owner: async () => {
      throw SPAWN_TIMEOUT;
    },
  });

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome).toMatchObject({
    launchConfirmation: 'unanswered',
    launchConfirmationReason: 'url-owner-unresolved',
  });
  expect(interactor.acceptAlert).not.toHaveBeenCalled();
});

test('a prompt open read but did not recognize reports the unanswered confirmation', async () => {
  const { lifecycle, interactor } = launchUrlSimulator(
    async () => ({ message: '0 pages', items: ['Cancel', 'Open'] }),
    [UNOBSERVABLE],
  );

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome).toMatchObject({
    launchConfirmation: 'unanswered',
    launchConfirmationReason: 'alert-unrecognized',
  });
  expect(interactor.acceptAlert).not.toHaveBeenCalled();
});

test('a prompt whose URL owner stays unresolved reports the unanswered confirmation', async () => {
  const { lifecycle, interactor } = launchUrlSimulator(async () => CONFIRMATION, [UNOBSERVABLE], {
    owner: async () => undefined,
  });

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome).toMatchObject({
    launchConfirmation: 'unanswered',
    launchConfirmationReason: 'url-owner-unresolved',
  });
  expect(interactor.acceptAlert).not.toHaveBeenCalled();
});

test('an accept that dies with the runner session hands the URL over again and reads once more', async () => {
  let accepts = 0;
  const readAlert = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockResolvedValueOnce(CONFIRMATION)
    .mockRejectedValueOnce(SPAWN_TIMEOUT)
    .mockResolvedValue(CONFIRMATION);
  const { lifecycle, events } = launchUrlSimulator(
    readAlert,
    [UNOBSERVABLE, UNOBSERVABLE, OBSERVABLE],
    {
      acceptAlert: async () => {
        accepts += 1;
        if (accepts === 1) throw SPAWN_TIMEOUT;
        return {};
      },
    },
  );

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome.launchConfirmation).toBe('accepted');
  expect(outcome.timing.postOpenObservation).toBe('observable');
  // The re-dispatch hands the URL as its own open target, the way the follow-up open does.
  expect(events).toEqual([
    'release',
    `open ${LAUNCH_URL}`,
    'observe unobservable',
    'alert wait',
    'alert accept',
    'alert get',
    'observe unobservable',
    'open',
    'alert wait',
    'alert accept',
    'observe observable',
  ]);
});

test('an accept whose read-back also fails reports the unknown prompt state', async () => {
  const readAlert = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockResolvedValueOnce(CONFIRMATION)
    .mockRejectedValue(SPAWN_TIMEOUT);
  const { lifecycle } = launchUrlSimulator(readAlert, [UNOBSERVABLE, COMING_UP], {
    acceptAlert: async () => {
      throw SPAWN_TIMEOUT;
    },
  });

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome.launchConfirmation).toBeUndefined();
  expect(outcome).toMatchObject({ launchConfirmationProbeFailure: 'alert-accept' });
});

test('a redispatch whose second probe fails reports the unknown state, not the earlier accept', async () => {
  // Round 1 accepts but the app stays proven not running, so the URL is handed over again; round 2
  // cannot even read the prompt. The earlier accepted must not hide the unknown final state.
  const readAlert = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockResolvedValueOnce(CONFIRMATION)
    .mockRejectedValue(SPAWN_TIMEOUT);
  const { lifecycle } = launchUrlSimulator(readAlert, [UNOBSERVABLE, UNOBSERVABLE, COMING_UP]);

  const outcome = await lifecycle.openApplication(launchUrlInput());

  expect(outcome.launchConfirmation).toBeUndefined();
  expect(outcome).toMatchObject({ launchConfirmationProbeFailure: 'alert-read' });
});

test.each([
  ['still coming up', COMING_UP],
  ['observable', OBSERVABLE],
  ['not running', UNOBSERVABLE],
])(
  'a failed accept rejects a persistent launch prompt while the app is %s',
  async (_name, afterAnswer) => {
    const { lifecycle, interactor, events } = launchUrlSimulator(
      async () => CONFIRMATION,
      [BRIDGE_CIRCUIT, afterAnswer],
      {
        acceptAlert: async () => {
          throw new AppError('COMMAND_FAILED', 'alert accept exhausted its deadline', {
            runnerErrorCode: 'ALERT_DEADLINE_EXCEEDED',
          });
        },
      },
    );

    await expect(lifecycle.openApplication(launchUrlInput())).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'launch_confirmation_unanswered', appBundleId: 'com.example.app' },
    });
    expect(interactor.acceptAlert).toHaveBeenCalledOnce();
    expect(interactor.awaitAlert).toHaveBeenCalledOnce();
    expect(interactor.readAlert).toHaveBeenCalledOnce();
    expect(events.filter((event) => event === 'open' || event === `open ${LAUNCH_URL}`)).toEqual([
      `open ${LAUNCH_URL}`,
    ]);
  },
);

test.each([
  {
    name: 'absent',
    readAfterFailure: async () => {
      throw alertNotFound();
    },
  },
  {
    name: 'unreadable',
    readAfterFailure: async () => {
      throw SPAWN_TIMEOUT;
    },
  },
  {
    name: 'replaced by the same title with unrelated buttons',
    readAfterFailure: async () => ({ message: CONFIRMATION.message, items: ['Allow', 'Deny'] }),
  },
  {
    name: 'replaced by another launch confirmation',
    readAfterFailure: async () => ({ ...CONFIRMATION, message: 'Open in “Other App”?' }),
  },
])(
  'a failed accept with its prompt $name preserves launch-transition policy',
  async ({ readAfterFailure }) => {
    const readAlert = vi.fn(readAfterFailure).mockResolvedValueOnce(CONFIRMATION);
    const { lifecycle, interactor, events } = launchUrlSimulator(
      readAlert,
      [BRIDGE_CIRCUIT, COMING_UP],
      {
        acceptAlert: async () => {
          throw SPAWN_TIMEOUT;
        },
      },
    );

    const outcome = await lifecycle.openApplication(launchUrlInput());

    expect(outcome.launchConfirmation).toBeUndefined();
    expect(outcome.timing.postOpenObservation).toBe('unobservable');
    expect(interactor.acceptAlert).toHaveBeenCalledOnce();
    expect(interactor.awaitAlert).toHaveBeenCalledOnce();
    expect(interactor.readAlert).toHaveBeenCalledOnce();
    expect(events.filter((event) => event === 'open' || event === `open ${LAUNCH_URL}`)).toEqual([
      `open ${LAUNCH_URL}`,
    ]);
  },
);

test('an accept leaving a launch-transition window open stays green and re-hands nothing', async () => {
  const { lifecycle, events } = launchUrlSimulator(
    async () => CONFIRMATION,
    [UNOBSERVABLE, COMING_UP],
  );

  const outcome = await lifecycle.openApplication(launchUrlInput());

  // The window proves only that the app was still coming up, which no second hand-off can fix.
  expect(outcome.launchConfirmation).toBe('accepted');
  expect(outcome.timing.postOpenObservation).toBe('unobservable');
  expect(events).toEqual([
    'release',
    `open ${LAUNCH_URL}`,
    'observe unobservable',
    'alert wait',
    'alert accept',
    'observe unobservable',
  ]);
});

test('a launch URL handed over twice that still leaves no process fails the open', async () => {
  const readAlert = vi
    .fn<() => Promise<Record<string, unknown>>>()
    .mockResolvedValueOnce(CONFIRMATION)
    .mockRejectedValueOnce(SPAWN_TIMEOUT)
    .mockResolvedValueOnce(CONFIRMATION)
    .mockRejectedValueOnce(SPAWN_TIMEOUT);
  const { lifecycle, events } = launchUrlSimulator(
    readAlert,
    Array.from({ length: 3 }, () => UNOBSERVABLE),
    {
      acceptAlert: async () => {
        throw SPAWN_TIMEOUT;
      },
    },
  );

  const failure = await lifecycle
    .openApplication(launchUrlInput())
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).details).toMatchObject({
    reason: 'launch_confirmation_unanswered',
    appBundleId: 'com.example.app',
  });
  expect(events.filter((event) => event === 'open' || event === `open ${LAUNCH_URL}`)).toEqual([
    `open ${LAUNCH_URL}`,
    'open',
  ]);
});

test('a launch URL whose scheme another app owns fails the open without accepting it', async () => {
  urlOwner.resolve = async () => 'com.example.other';
  const { lifecycle, interactor } = launchUrlSimulator(async () => CONFIRMATION, [UNOBSERVABLE]);

  const failure = await lifecycle
    .openApplication(launchUrlInput())
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(AppError);
  expect((failure as AppError).details).toMatchObject({
    reason: 'launch_confirmation_foreign_app',
    foreignAppBundleId: 'com.example.other',
    sessionAppBundleId: 'com.example.app',
  });
  expect(interactor.acceptAlert).not.toHaveBeenCalled();
});

test.each([
  ['no launch URL', undefined],
  ['a web launch URL', 'https://example.com/automation'],
])('a Simulator open with %s never reads an alert', async (_name, runtimeLaunchUrl) => {
  const { lifecycle, interactor } = launchUrlSimulator(async () => ({}), [UNOBSERVABLE]);

  const outcome = await lifecycle.openApplication({ ...launchUrlInput(), runtimeLaunchUrl });

  expect(outcome.launchConfirmation).toBeUndefined();
  expect(outcome.timing.runnerDemand).toBe('none');
  expect(interactor.awaitAlert).not.toHaveBeenCalled();
});

test('a physical iOS launch URL never reads an alert', async () => {
  const { interactor } = launchUrlSimulator(async () => ({}), [UNOBSERVABLE]);
  const lifecycle = bindAppleApplicationLifecycle({
    host: {
      ...platformRuntimeHostFixture(),
      localInteractors: { resolve: async () => interactor },
    } as unknown as PlatformRuntimeHost,
    device,
    signal: new AbortController().signal,
  });

  const outcome = await lifecycle.openApplication({ ...launchUrlInput(), relaunch: false });

  expect(outcome.launchConfirmation).toBeUndefined();
  expect(interactor.awaitAlert).not.toHaveBeenCalled();
});
