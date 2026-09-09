import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import {
  defineAndroidContractEvidence,
  type AndroidContractEvidence,
} from '../android-emulator-e2e/contract-evidence.ts';

/** A named test in this repository: the file that owns it and the test's own name. */
export type RepositoryEvidence = {
  path: string;
  test: string;
};

const C = PUBLIC_COMMANDS;

// Tracking issues for the known-gap rows each platform still carries.
export const MACOS_COVERAGE_GAP_ISSUE = 1916;
export const TVOS_COVERAGE_GAP_ISSUE = 1914;
export const WEB_COVERAGE_GAP_ISSUE = 1900;
export const LINUX_COVERAGE_GAP_ISSUE = 1915;

// Android contract evidence that only the coverage declarations cite. Evidence shared with a
// production test module keeps living next to that module and is imported by declarations.ts.
export const ANDROID_APPLICATION_LIFECYCLE_CONTRACT_EVIDENCE: AndroidContractEvidence =
  defineAndroidContractEvidence(
    'packages/platform-android/src/runtime.test.ts',
    [C.prepare],
    'classifies the Android %s lifecycle denominator against the legacy dispatch cell',
  );
export const ANDROID_HOVER_RUNTIME_CONTRACT_EVIDENCE: AndroidContractEvidence =
  defineAndroidContractEvidence(
    'packages/platform-android/src/runtime.test.ts',
    [C.hover],
    'classifies the Android %s runtime denominator',
  );
export const ANDROID_TV_REMOTE_RUNTIME_CONTRACT_EVIDENCE: AndroidContractEvidence =
  defineAndroidContractEvidence(
    'packages/platform-android/src/runtime.test.ts',
    [C.tvRemote],
    'classifies Android %s back/home/orientation/keyboard facts through the shared touch gate',
  );
export const ANDROID_VIEWPORT_RUNTIME_CONTRACT_EVIDENCE: AndroidContractEvidence =
  defineAndroidContractEvidence(
    'src/daemon/__tests__/viewport-runtime.test.ts',
    [C.viewport],
    'rejects an unavailable exact-owner fact before binding',
  );

export const TVOS_REMOTE_TEST_NAME =
  'Provider-backed integration tvOS remote flow maps navigation commands to runner remote presses';
export const TVOS_REMOTE_EVIDENCE: RepositoryEvidence = {
  path: 'test/integration/provider-scenarios/tvos-remote.test.ts',
  test: TVOS_REMOTE_TEST_NAME,
};
export const TVOS_AUDIO_EVIDENCE: RepositoryEvidence = {
  path: 'packages/platform-apple/src/runtime.test.ts',
  test: 'tvOS audio capture availability follows the exact host-owned runtime fact',
};

export const WEB_SMOKE_TEST_NAME = 'live web platform e2e smoke';
export const WEB_SMOKE_EVIDENCE: RepositoryEvidence = {
  path: 'test/integration/smoke-web-platform.test.ts',
  test: WEB_SMOKE_TEST_NAME,
};

export const LINUX_REPLAY_EVIDENCE: RepositoryEvidence = {
  path: 'test/integration/replays/linux/01-desktop-smoke.ad',
  test: '# Smoke test for Linux desktop automation on CI.',
};
export const LINUX_COMMAND_EVIDENCE: RepositoryEvidence = {
  path: 'test/integration/linux-e2e/live-runner.ts',
  test: 'runLinuxCommandEvidence',
};
export const LINUX_PROVIDER_EVIDENCE: RepositoryEvidence = {
  path: 'test/integration/provider-scenarios/linux-desktop.test.ts',
  test: 'Provider-backed integration Linux desktop flow uses semantic desktop and input providers',
};
export const LINUX_RUNTIME_EVIDENCE: RepositoryEvidence = {
  path: 'packages/platform-linux/src/runtime.test.ts',
  test: 'classifies the Linux $name lifecycle denominator against the legacy dispatch cell',
};
