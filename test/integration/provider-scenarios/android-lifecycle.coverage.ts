import { PUBLIC_COMMANDS as C } from '../../../src/command-catalog.ts';
import { defineAndroidContractEvidence } from '../android-emulator-e2e/contract-evidence.ts';

export const ANDROID_LIFECYCLE_CONTRACT_EVIDENCE = defineAndroidContractEvidence(
  'provider-scenarios/android-lifecycle',
  [
    C.batch,
    C.boot,
    C.clipboard,
    C.events,
    C.gesture,
    C.logs,
    C.network,
    C.perf,
    C.push,
    C.reactNative,
    C.reinstall,
    C.settings,
    C.shutdown,
    C.swipe,
    C.trace,
    C.triggerAppEvent,
  ],
  'Provider-backed integration Android Settings flow uses scripted ADB provider',
);

export const ANDROID_TOUCH_CONTRACT_EVIDENCE = defineAndroidContractEvidence(
  'provider-scenarios/android-touch',
  [C.scroll],
  'Provider-backed integration Android touch provider handles multi-touch gestures',
);
