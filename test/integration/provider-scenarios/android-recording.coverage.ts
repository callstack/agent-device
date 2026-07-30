import { PUBLIC_COMMANDS as C } from '../../../src/command-catalog.ts';
import { defineAndroidContractEvidence } from '../android-emulator-e2e/contract-evidence.ts';

export const ANDROID_RECORDING_CONTRACT_EVIDENCE = defineAndroidContractEvidence(
  'provider-scenarios/android-recording',
  [C.record],
  'Provider-backed integration Android recording flow uses scripted ADB provider pull capability',
);
