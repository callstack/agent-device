import { PUBLIC_COMMANDS as C } from '../../../command-catalog.ts';

export const ANDROID_AUDIO_CONTRACT_EVIDENCE = {
  commands: [C.audio],
  owner: 'daemon/session-audio',
  testName: 'audio probe starts host helper for Android emulator audio',
} as const;
