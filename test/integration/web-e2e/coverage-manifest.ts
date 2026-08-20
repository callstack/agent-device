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
      level: 'capability-denial';
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
const denial = (assertion: string): WebPlatformCoverageEntry => ({
  assertion,
  level: 'capability-denial',
});
const gap = (assertion: string): WebPlatformCoverageEntry => ({
  assertion,
  level: 'known-gap',
  trackingIssue: WEB_COVERAGE_GAP_ISSUE,
});

/**
 * One primary, observable owner for every public command on the managed web target.
 *
 * Live rows are limited to the existing web-smoke scenario. Contract rows cite
 * existing web-specific unit/provider evidence; they do not turn fixture-backed
 * tests into live E2E claims. Capability denials are derived from the web bucket
 * in the command capability matrix. Known gaps are explicit follow-up work, not
 * an implicit claim that a generic command works on web.
 */
export const WEB_PLATFORM_COVERAGE = {
  [C.artifacts]: gap('No web-specific artifact inventory command evidence exists yet'),
  [C.devices]: contract(
    'test/integration/provider-scenarios/web-desktop.test.ts',
    'Provider-backed integration web desktop flow uses semantic web provider calls',
    'web inventory returns the established browser target',
  ),
  [C.capabilities]: contract(
    'src/daemon/handlers/__tests__/session-capabilities.test.ts',
    'capabilities omits apps when $label runtime facts deny the operation',
    'web capability projection reflects runtime-owned unsupported operations',
  ),
  [C.doctor]: contract(
    'src/daemon/handlers/__tests__/session-doctor-web.test.ts',
    'web doctor lifecycle check reports live managed Chrome process count',
    'web doctor reports managed browser lifecycle evidence',
  ),
  [C.apps]: contract(
    'src/daemon/handlers/__tests__/session-capabilities.test.ts',
    'capabilities omits apps when $label runtime facts deny the operation',
    'web runtime facts keep native app inventory unavailable',
  ),
  [C.boot]: gap('Web boot has no command-level executable evidence'),
  [C.shutdown]: gap('Web shutdown has no command-level executable evidence'),
  [C.appState]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'preserves a narrow web provider dump including empty successful entries',
    'web runtime facts keep app state unavailable',
  ),
  [C.perf]: denial('Web capability model rejects native performance inspection'),
  [C.logs]: gap('Web app-log commands have no command-level executable evidence'),
  [C.events]: gap('Web session event timeline has no command-level executable evidence'),
  [C.network]: live('network dump returns the fixture GET request and requested headers'),
  [C.audio]: contract(
    'src/daemon/handlers/__tests__/session-audio.test.ts',
    'audio probe forwards daemon millisecond timing to web provider',
    'web audio probe forwards typed duration and bucket values',
  ),
  [C.replay]: gap('Web replay has no executable command evidence'),
  [C.test]: gap('Web test-suite execution has no executable command evidence'),
  [C.clipboard]: denial('Web capability model rejects native clipboard operations'),
  [C.keyboard]: denial('Web capability model rejects native keyboard operations'),
  [C.install]: gap('Web application installation has no command-level executable evidence'),
  [C.reinstall]: gap('Web application reinstallation has no command-level executable evidence'),
  [C.push]: gap('Web application push delivery has no command-level executable evidence'),
  [C.triggerAppEvent]: denial('Web capability model rejects native app event delivery'),
  [C.open]: live('the managed browser opens the local fixture page'),
  [C.prepare]: contract(
    'packages/platform-web/src/runtime.test.ts',
    'preserves a narrow web provider dump including empty successful entries',
    'web runtime facts keep Apple runner preparation unavailable',
  ),
  [C.batch]: gap('Web batch execution has no command-level executable evidence'),
  [C.close]: live('close releases the managed browser session during smoke cleanup'),
  [C.snapshot]: live('interactive snapshot exposes the fixture ready marker and form controls'),
  [C.diff]: gap('Web snapshot diff has no command-level executable evidence'),
  [C.wait]: live('wait observes ready text and post-interaction fixture state'),
  [C.alert]: denial('Web capability model rejects native alert operations'),
  [C.settings]: denial('Web capability model rejects native device settings operations'),
  [C.reactNative]: denial('Web capability model rejects React Native inspection'),
  [C.record]: contract(
    'test/integration/provider-scenarios/web-desktop.test.ts',
    'start web recording',
    'web recording starts and stops through the scoped provider',
  ),
  [C.trace]: gap('Web trace capture has no command-level executable evidence'),
  [C.find]: live('find locates the ready marker through text and selector expressions'),
  [C.click]: live('click changes the fixture status to Submitted'),
  [C.fill]: live('fill updates the accessible email value and fixture status'),
  [C.longPress]: denial('Web capability model rejects touch long-press input'),
  [C.hover]: contract(
    'test/integration/provider-scenarios/web-desktop.test.ts',
    'hover submit ref',
    'web hover moves the pointer through the provider element handle',
  ),
  [C.press]: gap('Web press has no direct command-level executable evidence'),
  [C.type]: contract(
    'test/integration/provider-scenarios/web-desktop.test.ts',
    'type suffix',
    'web type appends text to the focused field through the provider',
  ),
  [C.get]: live('get reads the ready marker text from the fixture'),
  [C.is]: live('is visible passes for the Submit order control'),
  [C.back]: denial('Web capability model rejects native back navigation'),
  [C.gesture]: denial('Web capability model rejects touch gesture input'),
  [C.home]: denial('Web capability model rejects native Home navigation'),
  [C.tvRemote]: denial('Web capability model rejects TV remote input'),
  [C.orientation]: denial('Web capability model rejects native orientation changes'),
  [C.scroll]: contract(
    'test/integration/provider-scenarios/web-desktop.test.ts',
    'scroll by pixels',
    'web scroll moves the provider-backed page by the requested pixels',
  ),
  [C.swipe]: denial('Web capability model rejects touch swipe input'),
  [C.focus]: contract(
    'src/core/__tests__/web-interactor.test.ts',
    'web interactor delegates first-slice operations to the scoped provider',
    'web focus delegates to the scoped provider click primitive',
  ),
  [C.screenshot]: live('screenshot creates a valid 640x480 PNG artifact'),
  [C.viewport]: live('viewport resizes the browser and the PNG reports 640x480 dimensions'),
  [C.appSwitcher]: denial('Web capability model rejects native app switcher navigation'),
  [C.installFromSource]: gap('Web source installation has no command-level executable evidence'),
} satisfies Record<PublicCommand, WebPlatformCoverageEntry>;

export const WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(WEB_PLATFORM_COVERAGE),
);

export function liveCommandsForWebSmoke(): PublicCommand[] {
  return Object.entries(WEB_PLATFORM_COVERAGE)
    .filter(([, entry]) => entry.level === 'live')
    .map(([command]) => command as PublicCommand);
}
