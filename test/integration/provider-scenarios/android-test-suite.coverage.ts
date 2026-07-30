import { PUBLIC_COMMANDS as C } from '../../../src/command-catalog.ts';
import { defineAndroidContractEvidence } from '../android-emulator-e2e/contract-evidence.ts';

export const ANDROID_TEST_SUITE_CONTRACT_EVIDENCE = defineAndroidContractEvidence(
  'provider-scenarios/android-test-suite',
  [C.test],
  'Provider-backed integration Android replay test suite covers retries and fail-fast flags',
);
