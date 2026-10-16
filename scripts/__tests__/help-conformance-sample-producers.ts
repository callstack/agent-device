import type { CapturedSample } from '../help-conformance-sample-outputs.mjs';
import { withCapturedStderrAsync } from '../../src/__tests__/test-utils/stream-capture.ts';
import {
  AMBIGUOUS_MATCH_SAMPLE,
  APP_NOT_INSTALLED_SAMPLE,
  BROWSERSTACK_CONNECT_SAMPLE,
  DEVICE_IN_USE_SAMPLE,
  DEVICE_CLAIM_IN_USE_SAMPLE,
  FOREGROUND_SNAPSHOT_FAILURE_SAMPLE,
  MERGED_CARD_ACTIONS_SAMPLE,
  NOT_SETTLED_SAMPLE,
  OFFSCREEN_TARGET_SNAPSHOT_SAMPLE,
  PRIVATE_AX_RECOVERY_SAMPLE,
  SETTLE_DIFF_SAMPLE,
  SETTLE_DIFF_SAMPLE_NOTES,
  SETTLE_TAIL_SAMPLE,
  STALE_REF_SAMPLE,
} from '../help-conformance-sample-outputs.mjs';
import { interactionCliOutputFormatters } from '../../src/commands/interaction/output.ts';
import { snapshotCliOutput } from '../../src/commands/capture/output.ts';
import { openCliOutput } from '../../src/commands/management/output.ts';
import { NEVER_SETTLED_HINT } from '../../src/commands/interaction/runtime/settle.ts';
import { buildAppNotInstalledError } from '@agent-device/platform-apple/app-resolution';
import {
  presentConnectReadiness,
  renderConnectSuccess,
} from '../../src/cli/commands/connection-presentation.ts';
import type { ConnectVerification } from '../../src/cli/connection/connect-provider-adapters.ts';
import type { RemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import { renderSnapshotQualityWarnings } from '@agent-device/capture-kit/quality-warnings';
import { printHumanError } from '../../src/commands/output/error.ts';
import { formatSnapshotText } from '../../src/commands/output/snapshot.ts';

// The production renderer behind each captured sample in
// scripts/help-conformance-sample-outputs.mjs, as data rather than as one test
// per sample. help-conformance-sample-outputs.test.ts asserts every entry
// rebuilds its sample's exact text, and
// help-conformance-error-recovery-coverage.test.ts asserts every exported
// sample HAS an entry here — so a new sample cannot ship pinned to nothing but
// its own transcription, which is the drift class this registry exists to
// prevent.

export type SampleProducer = {
  /** Export name in help-conformance-sample-outputs.mjs, for test titles. */
  name: string;
  /** What the sample is pinned to, read as "<name> matches <producer>". */
  producer: string;
  sample: CapturedSample;
  /** The sample's text rebuilt from production code, ready to compare. */
  render: () => string | Promise<string>;
};

const formatPress = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.press({ input: {}, result }).text;

const formatFill = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.fill({ input: {}, result }).text;

/** The `Error (CODE): …` + `Hint: …` text printHumanError writes to stderr. */
async function renderHumanError(error: AppError): Promise<string> {
  const stderr = await withCapturedStderrAsync(async () => {
    await printHumanError(normalizeError(error));
  });
  return stderr.trimEnd();
}

type ErrorResponse = {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    retriable?: boolean;
    details?: Record<string, unknown>;
  };
};

/** Renders a daemon error response the way the CLI prints it for a human. */
async function renderErrorResponse(response: ErrorResponse): Promise<string> {
  return await renderHumanError(
    new AppError(
      response.error.code as ConstructorParameters<typeof AppError>[0],
      response.error.message,
      {
        ...response.error.details,
        ...(response.error.hint ? { hint: response.error.hint } : {}),
        ...(response.error.retriable === undefined ? {} : { retriable: response.error.retriable }),
      } as ConstructorParameters<typeof AppError>[2],
    ),
  );
}

export const SAMPLE_PRODUCERS: SampleProducer[] = [
  {
    name: 'SETTLE_TAIL_SAMPLE',
    producer: 'the press renderer, including ADR 0014 ref pinning',
    sample: SETTLE_TAIL_SAMPLE,
    render: () =>
      formatPress({
        ref: 'e37',
        x: 203,
        y: 88,
        settle: {
          settled: true,
          waitedMs: 540,
          refsGeneration: 5,
          diff: {
            summary: { additions: 0, removals: 1, unchanged: 15 },
            lines: [{ kind: 'removed', text: '@e50 [text] "Suggested for you"' }],
          },
          tail: [
            { ref: 'e64', role: 'text-field', label: 'Search' },
            { ref: 'e65', role: 'text', label: 'Recent searches' },
            { ref: 'e12', role: 'tab', label: 'Home' },
            { ref: 'e40', role: 'tab', label: 'Profile' },
          ],
        },
      }),
  },
  {
    name: 'SETTLE_DIFF_SAMPLE',
    producer: 'the fill renderer',
    sample: SETTLE_DIFF_SAMPLE,
    render: () =>
      formatFill({
        text: 'callstack',
        message: 'Filled 9 chars',
        settle: {
          settled: true,
          waitedMs: 610,
          refsGeneration: 6,
          diff: {
            summary: { additions: 2, removals: 0, unchanged: 18 },
            lines: [
              { kind: 'added', text: '@e64 [button] "@callstack.com"' },
              { kind: 'added', text: '@e65 [text] "Callstack"' },
            ],
          },
        },
      }),
  },
  {
    name: 'SETTLE_DIFF_SAMPLE_NOTES',
    producer: 'the fill renderer (metamorphic twin)',
    sample: SETTLE_DIFF_SAMPLE_NOTES,
    render: () =>
      formatFill({
        text: 'groceries',
        message: 'Filled 9 chars',
        settle: {
          settled: true,
          waitedMs: 480,
          refsGeneration: 3,
          diff: {
            summary: { additions: 2, removals: 0, unchanged: 11 },
            lines: [
              { kind: 'added', text: '@e21 [button] "Groceries list"' },
              { kind: 'added', text: '@e22 [text] "3 items"' },
            ],
          },
        },
      }),
  },
  {
    name: 'NOT_SETTLED_SAMPLE',
    producer: 'the press renderer and the production NEVER_SETTLED_HINT',
    sample: NOT_SETTLED_SAMPLE,
    render: () =>
      formatPress({
        ref: 'e12',
        x: 166,
        y: 240,
        settle: { settled: false, waitedMs: 10_000, hint: NEVER_SETTLED_HINT },
      }),
  },
  {
    name: 'PRIVATE_AX_RECOVERY_SAMPLE',
    producer: 'the snapshot renderer and the snapshot-quality warning',
    sample: PRIVATE_AX_RECOVERY_SAMPLE,
    render: async () => {
      const nodes = [
        {
          index: 1,
          ref: 'e5',
          type: 'Button',
          label: 'Search',
          interactive: true,
          rect: { x: 20, y: 120, width: 200, height: 44 },
        },
        {
          index: 2,
          ref: 'e8',
          type: 'Tab',
          label: 'Home',
          selected: true,
          interactive: true,
          rect: { x: 0, y: 780, width: 100, height: 60 },
        },
      ];
      const verdict = { state: 'recovered', backend: 'private-ax' } as SnapshotQualityVerdict;
      return formatSnapshotText({
        nodes,
        backend: 'private-ax',
        snapshotQuality: verdict,
        warnings: renderSnapshotQualityWarnings(verdict, nodes),
        interactiveOnly: true,
      }).trimEnd();
    },
  },
  {
    name: 'OFFSCREEN_TARGET_SNAPSHOT_SAMPLE',
    producer: 'the visible-first snapshot renderer with off-screen rows summarized',
    sample: OFFSCREEN_TARGET_SNAPSHOT_SAMPLE,
    render: () => {
      // A settings-style scrollable list in an 800pt viewport: five rows fit,
      // four more (Privacy & Security, Notifications, Wallpaper, Developer) are
      // laid out below it, so visible-first presentation summarizes them and
      // none of their refs reach the output.
      const row = (index: number, ref: string, label: string, y: number) => ({
        index,
        ref,
        parentIndex: 2,
        type: 'Cell',
        label,
        interactive: true,
        hittable: y < 800,
        rect: { x: 0, y, width: 390, height: 120 },
      });
      const nodes = [
        {
          index: 0,
          ref: 'e1',
          type: 'Application',
          label: 'Preferences',
          rect: { x: 0, y: 0, width: 390, height: 800 },
        },
        {
          index: 1,
          ref: 'e2',
          parentIndex: 0,
          type: 'Window',
          rect: { x: 0, y: 0, width: 390, height: 800 },
        },
        {
          index: 2,
          ref: 'e3',
          parentIndex: 1,
          type: 'CollectionView',
          interactive: true,
          rect: { x: 0, y: 60, width: 390, height: 740 },
        },
        row(3, 'e4', 'General', 60),
        row(4, 'e5', 'Display', 190),
        row(5, 'e6', 'Sounds', 320),
        row(6, 'e7', 'Focus', 450),
        row(7, 'e8', 'Screen Time', 580),
        row(8, 'e9', 'Privacy & Security', 900),
        row(9, 'e10', 'Notifications', 1030),
        row(10, 'e11', 'Wallpaper', 1160),
        row(11, 'e12', 'Developer', 1290),
      ];
      return formatSnapshotText(
        { nodes, backend: 'xctest', truncated: false },
        { interactiveOnly: true },
      ).trimEnd();
    },
  },
  {
    name: 'FOREGROUND_SNAPSHOT_FAILURE_SAMPLE',
    producer: 'the open success renderer with a failed composed snapshot',
    sample: FOREGROUND_SNAPSHOT_FAILURE_SAMPLE,
    render: async () => {
      const warning =
        'The session is open, but the initial interactive snapshot failed (COMMAND_FAILED: capture failed). Run: agent-device snapshot -i';
      return (
        (
          await openCliOutput({
            session: 'default',
            warnings: [warning],
            initialSnapshotError: {
              code: 'COMMAND_FAILED',
              message: 'capture failed',
            },
            identifiers: { session: 'default' },
          })
        ).text ?? ''
      );
    },
  },
  {
    name: 'MERGED_CARD_ACTIONS_SAMPLE',
    producer: "the snapshot renderer with --actions naming a merged element's custom actions",
    sample: MERGED_CARD_ACTIONS_SAMPLE,
    render: async () => {
      // A Bluesky-style feed item merged into one Link node: its Reply/Repost/
      // menu controls are AX custom actions, not child nodes, so they only
      // surface when --actions is passed through to the renderer.
      const nodes = [
        {
          index: 0,
          ref: 'e1',
          depth: 0,
          type: 'Application',
          label: 'Bluesky',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 1,
          ref: 'e2',
          parentIndex: 0,
          depth: 1,
          type: 'Window',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
        {
          index: 2,
          ref: 'e3',
          parentIndex: 1,
          depth: 2,
          type: 'CollectionView',
          interactive: true,
          rect: { x: 0, y: 60, width: 390, height: 700 },
        },
        {
          index: 3,
          ref: 'e72',
          parentIndex: 2,
          depth: 3,
          type: 'Link',
          label: 'feedItem-by-whiskers.test',
          interactive: true,
          rect: { x: 0, y: 60, width: 390, height: 140 },
          actions: ['Reply', 'Repost', 'Open post options menu'],
        },
      ];
      const output = await snapshotCliOutput({
        result: { nodes, backend: 'xctest', truncated: false },
        interactiveOnly: true,
      });
      return (output.text ?? '').trimEnd();
    },
  },
  {
    name: 'DEVICE_IN_USE_SAMPLE',
    producer: 'the session-open by-session conflict fixture',
    sample: DEVICE_IN_USE_SAMPLE,
    render: () => {
      return renderErrorResponse({
        ok: false,
        error: {
          code: 'DEVICE_IN_USE',
          message: 'Device is already in use by session "checkout".',
          hint: 'Run agent-device session list to inspect active sessions. To reuse this device, rerun the command with --session checkout. To open a new session on this device, first run agent-device close --session checkout.',
          details: {
            session: 'checkout',
            deviceId: 'SIM-001',
            deviceName: 'iPhone 17 Pro',
          },
        },
      });
    },
  },
  {
    name: 'DEVICE_CLAIM_IN_USE_SAMPLE',
    producer: 'the enforced device-claim conflict fixture',
    sample: DEVICE_CLAIM_IN_USE_SAMPLE,
    render: () => {
      return renderErrorResponse({
        ok: false,
        error: {
          code: 'DEVICE_IN_USE',
          message:
            'android device emulator-5554 is owned by session "checkout" in workspace "/worktrees/checkout".',
          hint: 'Inspect the owner with: agent-device device status --platform android --serial emulator-5554',
          details: {
            reason: 'DEVICE_CLAIM_LIVE_OWNER',
            classification: 'live',
            deviceKey: 'local:android:none:emulator-5554',
            owner: {
              session: 'checkout',
              workspace: '/worktrees/checkout',
              stateDir: '/state/checkout',
            },
            recovery: {
              command: 'agent-device device status --platform android --serial emulator-5554',
            },
            retriable: false,
          },
        },
      });
    },
  },
  {
    name: 'STALE_REF_SAMPLE',
    producer: 'the ADR 0014 stale-ref rejection fixture',
    sample: STALE_REF_SAMPLE,
    render: () => {
      return renderErrorResponse({
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: 'Ref @e12 was minted from a superseded snapshot generation',
          hint: "Ref @e12 was minted from snapshot s5 but the session's ref frame is now s7 — re-run snapshot -i.",
          details: { reason: 'stale_snapshot_ref', ref: '@e12', mintedGeneration: 5 },
        },
      });
    },
  },
  {
    name: 'AMBIGUOUS_MATCH_SAMPLE',
    producer: 'the ambiguous-find error fixture',
    sample: AMBIGUOUS_MATCH_SAMPLE,
    render: () => {
      return renderErrorResponse({
        ok: false,
        error: {
          code: 'AMBIGUOUS_MATCH',
          message:
            'find matched 3 elements for text "Follow". Use a more specific locator or selector.',
          hint: 'Multiple candidates matched. Narrow the query or pass an exact identifier.',
          details: {
            locator: 'text',
            query: 'Follow',
            matches: 3,
            candidates: ['@e2 [button] "Follow"', '@e5 [button] "Follow"', '@e9 [button] "Follow"'],
          },
        },
      });
    },
  },
  {
    name: 'APP_NOT_INSTALLED_SAMPLE',
    producer: 'the real app-resolution producer and the default hint',
    sample: APP_NOT_INSTALLED_SAMPLE,
    render: () => renderHumanError(buildAppNotInstalledError('Shoply')),
  },
  {
    name: 'BROWSERSTACK_CONNECT_SAMPLE',
    producer: 'the connect success renderer with verified BrowserStack readiness',
    sample: BROWSERSTACK_CONNECT_SAMPLE,
    render: () => {
      const state = {
        version: 1,
        session: 'adc-browserstack',
        tenant: 'direct-browserstack',
        runId: 'run-browserstack',
        leaseProvider: 'browserstack',
        platform: 'android',
        remoteConfigPath: '/tmp/browserstack.json',
        remoteConfigHash: 'fixture',
        connectedAt: '2026-08-03T00:00:00.000Z',
        updatedAt: '2026-08-03T00:00:00.000Z',
      } satisfies RemoteConnectionState;
      const facts = {
        provider: 'browserstack',
        service: 'BrowserStack',
        verificationMessage: 'Credentials, device, and uploaded app verified.',
        device: {
          status: 'verified',
          name: 'Google Pixel 8',
          platform: 'android',
          osVersion: '14.0',
        },
        app: {
          status: 'verified',
          name: 'sample.apk',
          reference: 'bs://app-id',
          version: '1.2.3',
        },
      } satisfies ConnectVerification;
      return renderConnectSuccess({
        state,
        readiness: presentConnectReadiness(state, facts),
      });
    },
  },
];
