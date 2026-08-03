import type { CapturedSample } from '../help-conformance-sample-outputs.mjs';
import {
  AMBIGUOUS_MATCH_SAMPLE,
  APP_NOT_INSTALLED_SAMPLE,
  BROWSERSTACK_CONNECT_SAMPLE,
  DEVICE_IN_USE_SAMPLE,
  NOT_SETTLED_SAMPLE,
  PRIVATE_AX_RECOVERY_SAMPLE,
  SETTLE_DIFF_SAMPLE,
  SETTLE_DIFF_SAMPLE_NOTES,
  SETTLE_TAIL_SAMPLE,
  STALE_REF_SAMPLE,
} from '../help-conformance-sample-outputs.mjs';
import { interactionCliOutputFormatters } from '../../src/commands/interaction/output.ts';
import { NEVER_SETTLED_HINT } from '../../src/commands/interaction/runtime/settle.ts';
import { buildAmbiguousMatchError } from '../../src/daemon/handlers/find.ts';
import { refMutationAdmissionResponse } from '../../src/daemon/handlers/interaction-ref-policy.ts';
import { buildDeviceInUseBySessionError } from '../../src/daemon/handlers/session-open.ts';
import { resolveRefStalenessWarning } from '../../src/daemon/session-snapshot.ts';
import type { SessionState } from '../../src/daemon/types.ts';
import { buildAppNotInstalledError } from '../../src/platforms/apple/core/app-resolution.ts';
import {
  presentConnectReadiness,
  renderConnectSuccess,
} from '../../src/cli/commands/connection-presentation.ts';
import type { ConnectVerification } from '../../src/cli/connection/connect-provider-adapters.ts';
import type { RemoteConnectionState } from '../../src/remote/remote-connection-state.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { SnapshotQualityVerdict } from '../../src/snapshot/snapshot-quality.ts';
import { renderSnapshotQualityWarnings } from '../../src/snapshot/snapshot-quality.ts';
import { formatSnapshotText, printHumanError } from '../../src/utils/output.ts';

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
  render: () => string;
};

const formatPress = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.press({ input: {}, result }).text;

const formatFill = (result: Record<string, unknown>) =>
  interactionCliOutputFormatters.fill({ input: {}, result }).text;

/** The `Error (CODE): …` + `Hint: …` text printHumanError writes to stderr. */
function renderHumanError(error: AppError): string {
  const lines: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    printHumanError(normalizeError(error));
  } finally {
    process.stderr.write = originalWrite;
  }
  return lines.join('').trimEnd();
}

type ErrorResponse = { ok: false; error: { code: string; message: string; details?: unknown } };

/** Renders a daemon error response the way the CLI prints it for a human. */
function renderErrorResponse(response: ErrorResponse): string {
  return renderHumanError(
    new AppError(
      response.error.code as ConstructorParameters<typeof AppError>[0],
      response.error.message,
      response.error.details as ConstructorParameters<typeof AppError>[2],
    ),
  );
}

function assertErrorResponse(
  response: { ok: boolean } | undefined,
  what: string,
): asserts response is ErrorResponse {
  if (!response || response.ok) throw new Error(`${what} must be an error response`);
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
    render: () => {
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
    name: 'DEVICE_IN_USE_SAMPLE',
    producer: 'the real session-open by-session conflict producer',
    sample: DEVICE_IN_USE_SAMPLE,
    render: () => {
      const owningSession = { name: 'checkout' } as SessionState;
      const device = { id: 'SIM-001', name: 'iPhone 17 Pro' } as Parameters<
        typeof buildDeviceInUseBySessionError
      >[1];
      const response = buildDeviceInUseBySessionError(owningSession, device);
      assertErrorResponse(response, 'the by-session conflict');
      return renderErrorResponse(response);
    },
  },
  {
    name: 'STALE_REF_SAMPLE',
    producer: 'the real ADR 0014 admission rejection and staleness hint',
    sample: STALE_REF_SAMPLE,
    render: () => {
      const session = { refFrameGeneration: 7 } as SessionState;
      const response = refMutationAdmissionResponse({
        session,
        ref: '@e12',
        mintedGeneration: 5,
        staleRefsWarning: resolveRefStalenessWarning({ session, ref: '@e12', mintedGeneration: 5 }),
      });
      assertErrorResponse(response, 'a superseded pin');
      return renderErrorResponse(response);
    },
  },
  {
    name: 'AMBIGUOUS_MATCH_SAMPLE',
    producer: 'the real find producer and the default hint',
    sample: AMBIGUOUS_MATCH_SAMPLE,
    render: () => {
      const matches = [
        { ref: 'e2', label: 'Follow' },
        { ref: 'e5', label: 'Follow' },
        { ref: 'e9', label: 'Follow' },
      ] as Parameters<typeof buildAmbiguousMatchError>[0];
      const response = buildAmbiguousMatchError(matches, 'text', 'Follow');
      assertErrorResponse(response, 'an ambiguous find');
      return renderErrorResponse(response);
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
