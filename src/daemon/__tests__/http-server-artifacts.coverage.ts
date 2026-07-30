import { PUBLIC_COMMANDS as C } from '../../command-catalog.ts';

export const ANDROID_ARTIFACTS_CONTRACT_EVIDENCE = {
  commands: [C.artifacts],
  owner: 'daemon/http-server-artifacts',
  testName: 'downloadable artifact inventory is filtered by tenant',
} as const;
