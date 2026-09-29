import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { defineAndroidContractEvidence } from '../../test/integration/android-emulator-e2e/contract-evidence.ts';

export const ANDROID_WEARABLE_PAIRING_CONTRACT_EVIDENCE = defineAndroidContractEvidence(
  'packages/platform-android/src/wearable-pairing.test.ts',
  [PUBLIC_COMMANDS.pairWearable],
  'reports a human step after proving the Wear identity and ADB transport',
);
