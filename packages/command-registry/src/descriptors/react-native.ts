import { ownerFilesEnabled, type RawCommandDescriptor } from '../descriptor-traits.ts';
import { tapPointUse } from '@agent-device/contracts/platform-runtime-operations';
import { DEFAULT_TIMEOUT_POLICY } from '../timeout-policy.ts';

/**
 * The React Native family (`src/commands/react-native/**`): the one command whose daemon route
 * owns the React Native DevTools overlay instead of a generic device operation.
 */
export const REACT_NATIVE_COMMAND_DESCRIPTORS = [
  // -- specialized routes --
  {
    name: 'react-native',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/commands/react-native/index.ts'] as const } : {}),
    catalog: { group: 'public', key: 'reactNative' },
    frameworkTier: 'extended',
    // R61 retires this command's capability bucket: admission is the owner's own `tapPoint` fact,
    // which is the one device operation the command executes. The overlay analysis and its
    // verification capture are daemon policy over an already-migrated snapshot route.
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'reactNative', refFrameEffect: 'may-invalidate' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: true,
    platformExecution: { kind: 'device-runtime', uses: [tapPointUse] },
  },
] as const satisfies readonly RawCommandDescriptor[];
