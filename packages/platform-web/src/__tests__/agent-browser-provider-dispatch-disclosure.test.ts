// contracts/fixtures/dispatch-disclosure.json, web-agent-browser rows: each drives the real
// provider entry point over a scripted agent-browser CLI and asserts the `details.dispatched`
// (and `details.dispatchedSteps`) the failure leaves behind. The envelopes are what the managed
// backend answers, including its typed CLI-refusal `type`; where the pinned CLI cannot
// produce one for a current provider argv, that row's driver says so.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
  bindTestCommandHost,
} from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { withCommandExecutorOverride, type ExecResult } from '@agent-device/host-kit/command';
import {
  agentBrowserJsonResult,
  mkdtempForTestSync,
  withManagedAgentBrowserProvider,
} from './test-utils.ts';
import { createAgentBrowserWebProvider } from '../agent-browser-provider.ts';
import type { WebProvider } from '../provider.ts';

bindTestCommandHost();

/** The managed install exists, but every CLI call is answered by `answer`. */
async function withScriptedBackend(
  answer: (cliArgs: readonly string[]) => ExecResult,
  runProviderCall: (provider: WebProvider) => Promise<unknown>,
): Promise<void> {
  await withManagedAgentBrowserProvider({ session: 'disclosure' }, async (provider) => {
    await withCommandExecutorOverride(
      async (_cmd: string, args: readonly string[]) => answer(args.slice(1)),
      async () => await runProviderCall(provider),
    );
  });
}

/**
 * Agent-browser answers a command with argv it cannot run, before it contacts the browser daemon.
 * This is the verbatim answer of the pinned CLI (0.39.0) for the argv the driver below sends.
 */
function refuseMissingArguments(): ExecResult {
  return agentBrowserJsonResult({
    error: 'Missing arguments for: keyboard type\nUsage: agent-browser keyboard type <text>',
    success: false,
    type: 'missing_arguments',
  });
}

/**
 * Agent-browser answers a command it does not implement before it reaches the browser daemon. No
 * argv the current provider sends is unknown to the pinned CLI, so this row covers the version skew where a
 * newer provider meets an older managed backend; the envelope is what such a CLI answers.
 */
function refuseUnknownCommand(): ExecResult {
  return agentBrowserJsonResult({
    error: 'Unknown command: --bogus',
    success: false,
    type: 'unknown_command',
  });
}

/** The envelope the backend answers once it has received and acted on a command. */
function backendRefused(error: string): ExecResult {
  return agentBrowserJsonResult({ success: false, data: null, error });
}

/** Answers the pointer sends the given way, and refuses everything else as the backend would. */
function answerPointerSends(
  failOn: 'down' | 'up' | 'press',
): (args: readonly string[]) => ExecResult {
  return (cliArgs) => {
    const command = cliArgs.slice(0, 2).join(' ');
    const pointerStepLanded =
      command === 'mouse move' ||
      (failOn !== 'down' && command === 'mouse down') ||
      (failOn !== 'down' && failOn !== 'up' && command === 'mouse up');
    if (pointerStepLanded) return agentBrowserJsonResult({ success: true, data: {} }, 0);
    if (failOn === 'down' || failOn === 'up') return backendRefused('Element not found.');
    return backendRefused('Target node detached.');
  };
}

/** Coordinate `click`: the move landed, the press was refused. */
async function clickRefusedOnPointerDown(): Promise<void> {
  let moves = 0;
  await withScriptedBackend(
    (cliArgs) => {
      if (cliArgs.slice(0, 2).join(' ') === 'mouse move') moves += 1;
      return answerPointerSends('down')(cliArgs);
    },
    async (provider) => {
      await provider.click(20, 30);
      assert.equal(moves, 1);
    },
  );
}

/** Coordinate `fill`: the whole click landed, the select-all press was refused. */
async function fillRefusedAfterClick(): Promise<void> {
  let pointerSends = 0;
  await withScriptedBackend(
    (cliArgs) => {
      if (cliArgs[0] === 'mouse') pointerSends += 1;
      return answerPointerSends('press')(cliArgs);
    },
    async (provider) => {
      await provider.fill(20, 30, 'Ada');
      assert.equal(pointerSends, 3);
    },
  );
}

/** `scroll --duration` long enough to pace into steps: two landed, the third was refused. */
async function scrollRefusedOnThirdStep(): Promise<void> {
  let scrollSteps = 0;
  await withScriptedBackend(
    (cliArgs) => {
      if (cliArgs[0] !== 'scroll') return backendRefused('Unknown ref: e3');
      scrollSteps += 1;
      return scrollSteps <= 2
        ? agentBrowserJsonResult({ success: true, data: {} }, 0)
        : backendRefused('Scroll target detached.');
    },
    async (provider) => {
      await provider.scroll('down', { pixels: 300, durationMs: 120 });
      assert.equal(scrollSteps, 3);
    },
  );
}

/** The managed backend is not installed, so the CLI is never spawned. */
async function openWithMissingBackend(): Promise<void> {
  const provider = createAgentBrowserWebProvider({
    host: { env: process.env, cwd: process.cwd() },
    stateDir: mkdtempForTestSync('agent-device-web-disclosure-missing-'),
  });
  await provider.open('https://example.test');
}

/** One row's drive plus the `details.dispatchedSteps` it additionally demands. */
const DRIVERS: Record<string, { drive: () => Promise<unknown>; dispatchedSteps?: number }> = {
  'web-agent-browser.backend-missing': { drive: openWithMissingBackend },
  'web-agent-browser.cli-unknown-command': {
    drive: () =>
      withScriptedBackend(refuseUnknownCommand, async (provider) => {
        await provider.clickRef?.('@e3');
      }),
  },
  'web-agent-browser.cli-missing-arguments': {
    drive: () =>
      withScriptedBackend(refuseMissingArguments, async (provider) => {
        // `keyboard type` with nothing to type: the argv the provider really sends for an empty
        // typeText, which the pinned CLI refuses by type before it reaches the browser.
        await provider.typeText('');
      }),
  },
  'web-agent-browser.click-pointer-down-refused': {
    drive: clickRefusedOnPointerDown,
    dispatchedSteps: 1,
  },
  'web-agent-browser.scroll-third-step-refused': {
    drive: scrollRefusedOnThirdStep,
    dispatchedSteps: 2,
  },
  'web-agent-browser.fill-selection-press-refused': {
    drive: fillRefusedAfterClick,
    dispatchedSteps: 3,
  },
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every web-agent-browser dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DRIVERS));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const driver = DRIVERS[row.id];
    assert.ok(driver, `no driver for ${row.id}`);
    await assert.rejects(
      async () => await driver.drive(),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.dispatched, row.dispatched);
        assert.equal(error.details?.dispatchedSteps, driver.dispatchedSteps);
        return true;
      },
    );
  });
}

test('a backend-answered failure carries no provider verdict for the router to override', async () => {
  // The rows above prove what the provider stamps; this pins the complement, because a provider
  // that guessed `no` from the message text here would make a blind retry unsafe: the backend
  // received the click, and only the request router may default the verdict.
  await withScriptedBackend(
    () => backendRefused('Unknown ref: e3'),
    async (provider) => {
      await provider.clickRef?.('@e3');
    },
  ).then(
    () => assert.fail('the refusal must reject'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, undefined);
    },
  );
});
