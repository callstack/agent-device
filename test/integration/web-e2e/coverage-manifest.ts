import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { buildCoverageClassificationSummary } from '../support/coverage-classification.ts';

type PublicCommand = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];

type RepositoryEvidence = {
  path: string;
  test: string;
};

export type WebPlatformCoverageEntry =
  | {
      assertion: string;
      level: 'live' | 'command-contract';
      owner: RepositoryEvidence;
    }
  | {
      assertion: string;
      level: 'known-gap';
      trackingIssue: number;
    };

export const WEB_COVERAGE_GAP_ISSUE = 1900;
export const WEB_SMOKE_TEST_NAME = 'live web platform e2e smoke';
export const WEB_SMOKE_EVIDENCE: RepositoryEvidence = {
  path: 'test/integration/smoke-web-platform.test.ts',
  test: WEB_SMOKE_TEST_NAME,
};

const C = PUBLIC_COMMANDS;
const live = (assertion: string): WebPlatformCoverageEntry => ({
  assertion,
  level: 'live',
  owner: WEB_SMOKE_EVIDENCE,
});
const contract = (path: string, test: string, assertion: string): WebPlatformCoverageEntry => ({
  assertion,
  level: 'command-contract',
  owner: { path, test },
});
const gap = (assertion: string): WebPlatformCoverageEntry => ({
  assertion,
  level: 'known-gap',
  trackingIssue: WEB_COVERAGE_GAP_ISSUE,
});

/**
 * One primary, observable owner for every public command on the managed web target.
 *
 * Live rows are limited to the existing web-smoke scenario; they do not widen its scope. Contract
 * rows do not
 * turn fixture-backed tests into live E2E claims, and cite one of two evidence shapes: a
 * web-specific unit/provider test exercising the command's own operation (e.g. `click`, `hover`);
 * or, for a command whose handler has no platform branch at all, a test proving its existing
 * generic/shared code path runs correctly for a web-backed session or device (e.g. `artifacts`,
 * `batch`, `diff`, `press`), OR the web runtime's own unavailable-operation fact, a real and
 * permanent denial (e.g. `boot`, `push`).
 *
 * #1900 closed 14 of the 15 known-gap rows this manifest originally carried using the shapes
 * above. `test` stays `known-gap`: its declared-platform filter structurally excludes web
 * (`ReplayTestPlatform = Exclude<PlatformSelector, 'web'>`), so `test --platform web` can never
 * select a script — real, tested, command-specific behavior (see
 * `session-command-replay.test.ts`), but evidence of what the command cannot do, not executable
 * evidence that it works on web. Closing this row needs a separate product decision: either web
 * replay-test support, or an explicit denial.
 */
export const WEB_PLATFORM_COVERAGE = {
  [C.artifacts]: contract(
    'src/daemon/__tests__/request-router-artifacts-web.test.ts',
    'artifacts lists a daemon-tracked artifact produced during a web session',
    'daemon artifact listing round-trips a tracked artifact for a web-backed session',
  ),
  [C.devices]: contract(
    'test/integration/provider-scenarios/web-desktop.test.ts',
    'Provider-backed integration web desktop flow uses semantic web provider calls',
    'web inventory returns the established browser target',
  ),
  [C.capabilities]: contract(
    'src/daemon/session-lifecycle/internal/__tests__/session-capabilities.test.ts',
    'capabilities omits apps when $label runtime facts deny the operation',
    'web capability projection reflects runtime-owned unsupported operations',
  ),
  [C.doctor]: contract(
    'packages/platform-web/src/__tests__/doctor.test.ts',
    'web doctor lifecycle check reports live managed Chrome process count',
    'web doctor reports managed browser lifecycle evidence',
  ),
  [C.apps]: contract(
    'src/daemon/session-lifecycle/internal/__tests__/session-capabilities.test.ts',
    'capabilities omits apps when $label runtime facts deny the operation',
    'web runtime facts keep native app inventory unavailable',
  ),
  [C.boot]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'boot and shutdown report the runtime-owned unavailable readiness fact',
    'the web runtime fact rejects device boot',
  ),
  [C.shutdown]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'boot and shutdown report the runtime-owned unavailable readiness fact',
    'the web runtime fact rejects device shutdown',
  ),
  [C.appState]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'preserves a narrow web provider dump including empty successful entries',
    'web runtime facts keep app state unavailable',
  ),
  [C.perf]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'preserves a narrow web provider dump including empty successful entries',
    'web runtime facts explicitly report native performance operations unavailable',
  ),
  [C.logs]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'logs reports the runtime-owned unavailable app-log facts',
    'the web runtime fact rejects native app-log commands',
  ),
  [C.events]: contract(
    'src/daemon/__tests__/request-router-events.test.ts',
    'events reads the daemon-owned session timeline for a web-backed session',
    'the session-owned event timeline works the same for a web-backed session as any other platform',
  ),
  [C.network]: live('network dump returns the fixture GET request and requested headers'),
  [C.audio]: contract(
    'src/daemon/session-observability/internal/__tests__/session-audio.test.ts',
    'audio probe forwards daemon millisecond timing to the web query operation',
    'web audio probe forwards typed duration and bucket values',
  ),
  [C.replay]: contract(
    'src/daemon/handlers/__tests__/session-command-replay.test.ts',
    'replay inherits the parent web platform selector for each invoked step',
    'replay re-invokes each recorded step with no platform branch, so a web selector threads through unchanged',
  ),
  [C.test]: gap(
    "Web test-suite execution has no executable web evidence: ReplayTestPlatform = Exclude<PlatformSelector, 'web'> structurally excludes web from the declared-platform filter, so `test --platform web` can never select a script (proven by a regression test in session-command-replay.test.ts) — that is evidence of what the command cannot do, not that it works on web",
  ),
  [C.clipboard]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'clipboard, the app switcher, app events, settings and alerts carry no web bucket',
    'the exact-owner runtime fact rejects native clipboard operations on the web target',
  ),
  [C.keyboard]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'back/home/orientation/tv-remote/keyboard never carried a web capability bucket',
    'the exact-owner runtime fact rejects native keyboard operations on the web target',
  ),
  [C.install]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'install and reinstall share the runtime-owned unavailable deploy fact',
    'the web runtime fact rejects native app installation',
  ),
  [C.reinstall]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'install and reinstall share the runtime-owned unavailable deploy fact',
    'the web runtime fact rejects native app reinstallation',
  ),
  [C.push]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'push reports the runtime-owned unavailable readiness and push facts',
    'the web runtime fact rejects native push notification delivery',
  ),
  [C.triggerAppEvent]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'clipboard, the app switcher, app events, settings and alerts carry no web bucket',
    'the exact-owner runtime fact rejects native app-event delivery on the web target',
  ),
  [C.open]: live('the managed browser opens the local fixture page'),
  [C.prepare]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'preserves a narrow web provider dump including empty successful entries',
    'web runtime facts keep Apple runner preparation unavailable',
  ),
  [C.batch]: contract(
    'src/daemon/session-lifecycle/internal/__tests__/session-devices-batch-runtime.test.ts',
    'batch step forwards the parent web platform selector to each invoked step',
    'batch re-invokes each step through the normal dispatcher with no platform branch, so a web selector threads through unchanged',
  ),
  [C.close]: live('close releases the managed browser session during smoke cleanup'),
  [C.snapshot]: live('interactive snapshot exposes the fixture ready marker and form controls'),
  [C.diff]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'diff shares the admitted captureSnapshot fact that live snapshot and diff both require',
    'web diff shares the browser-admitted snapshot capture that backs the live snapshot command',
  ),
  [C.wait]: live('wait observes ready text and post-interaction fixture state'),
  [C.alert]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'clipboard, the app switcher, app events, settings and alerts carry no web bucket',
    'the exact-owner runtime fact rejects native alert handling on the web target',
  ),
  [C.settings]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'clipboard, the app switcher, app events, settings and alerts carry no web bucket',
    'the exact-owner runtime fact rejects native device settings on the web target',
  ),
  // R61: no owner fact refuses this command on a browser — its whole device work is one bound
  // `tapPoint` the web target admits — so it now runs and reports that no overlay is present.
  [C.reactNative]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'press shares the admitted tapPoint fact that live click, press and react-native require',
    'React Native overlay dismissal binds the same browser tap the live click command does',
  ),
  [C.record]: contract(
    'test/integration/provider-scenarios/web-desktop.test.ts',
    'start web recording',
    'web recording starts and stops through the scoped provider',
  ),
  [C.trace]: contract(
    'src/daemon/handlers/__tests__/trace-runtime.test.ts',
    'starts and stops one trace through the session-owned trace slot on a web session',
    'session-scoped trace start/stop bookkeeping works the same for a web session as any other platform',
  ),
  [C.find]: live('find locates the ready marker through text and selector expressions'),
  [C.click]: live('click changes the fixture status to Submitted'),
  [C.fill]: live('fill updates the accessible email value and fixture status'),
  [C.longPress]: contract(
    'packages/platform-web/src/runtime.ts',
    'longPress: readinessUnavailable',
    'the web runtime fact rejects touch long-press input',
  ),
  [C.hover]: contract(
    'test/integration/provider-scenarios/web-desktop.test.ts',
    'hover submit ref',
    'web hover moves the pointer through the provider element handle',
  ),
  [C.press]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'press shares the admitted tapPoint fact that live click, press and react-native require',
    'web press shares the browser-admitted tap operation that backs the live click command',
  ),
  [C.type]: contract(
    'test/integration/provider-scenarios/web-desktop.test.ts',
    'type suffix',
    'web type appends text to the focused field through the provider',
  ),
  [C.get]: live('get reads the ready marker text from the fixture'),
  [C.is]: live('is visible passes for the Submit order control'),
  [C.back]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'back/home/orientation/tv-remote/keyboard never carried a web capability bucket',
    'the exact-owner runtime fact rejects native back navigation on the web target',
  ),
  // R52/R54: the web refusal moved from the capability matrix to the web owner's own gesture
  // facts, so the evidence is the cell test rather than a mechanical matrix denial.
  [C.gesture]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'admits web scrolling and refuses every gesture tier',
    'the web runtime owner declares every gesture tier unavailable',
  ),
  [C.home]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'back/home/orientation/tv-remote/keyboard never carried a web capability bucket',
    'the exact-owner runtime fact rejects native Home navigation on the web target',
  ),
  [C.tvRemote]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'back/home/orientation/tv-remote/keyboard never carried a web capability bucket',
    'the exact-owner runtime fact rejects TV remote input on the web target',
  ),
  [C.orientation]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'back/home/orientation/tv-remote/keyboard never carried a web capability bucket',
    'the exact-owner runtime fact rejects native orientation changes on the web target',
  ),
  [C.scroll]: contract(
    'test/integration/provider-scenarios/web-desktop.test.ts',
    'scroll by pixels',
    'web scroll moves the provider-backed page by the requested pixels',
  ),
  [C.swipe]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'admits web scrolling and refuses every gesture tier',
    'swipe shares the gesture tiers the web runtime owner declares unavailable',
  ),
  [C.focus]: contract(
    'src/core/__tests__/web-interactor.test.ts',
    'web interactor delegates first-slice operations to the scoped provider',
    'web focus delegates to the scoped provider click primitive',
  ),
  [C.screenshot]: live('screenshot creates a valid 640x480 PNG artifact'),
  [C.viewport]: live('viewport resizes the browser and the PNG reports 640x480 dimensions'),
  [C.appSwitcher]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'clipboard, the app switcher, app events, settings and alerts carry no web bucket',
    'the exact-owner runtime fact rejects native app-switcher navigation on the web target',
  ),
  [C.installFromSource]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'install-from-source reports the runtime-owned unavailable materialize and deploy facts',
    'the web runtime fact rejects source-based app installation',
  ),
} satisfies Record<PublicCommand, WebPlatformCoverageEntry>;

export const WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(WEB_PLATFORM_COVERAGE),
);

export function liveCommandsForWebSmoke(): PublicCommand[] {
  return Object.entries(WEB_PLATFORM_COVERAGE)
    .filter(([, entry]) => entry.level === 'live')
    .map(([command]) => command as PublicCommand);
}
