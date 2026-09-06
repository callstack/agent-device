import { PUBLIC_COMMANDS as C } from '@agent-device/command-registry/catalog';

export const ANDROID_INSTALL_SOURCE_CONTRACT_EVIDENCE = {
  commands: [C.installFromSource],
  owner: 'provision-kit/install-source',
  testName: 'prepareAndroidInstallArtifact resolves package identity for direct APK URL sources',
} as const;
