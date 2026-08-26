// Types only, so the adb provider can carry a supplied IME helper without importing the helper
// implementation (the same split `snapshot-helper-types.ts` makes for the snapshot helper).

export type { AndroidImeHelperArtifact } from '@agent-device/contracts/android-helper-artifacts';
