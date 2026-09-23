import {
  ADMISSION_AND_LOCK_EXEMPT,
  allowAnyDeviceSessionless,
  INSTALL_TIMEOUT_POLICY,
  LEASE_ALLOCATE_TIMEOUT_POLICY,
  LEASE_TIMEOUT_POLICY,
  NO_PLATFORM_EXECUTION,
  ownerFilesEnabled,
  REQUEST_EXECUTION_EXEMPT,
  type RawCommandDescriptor,
} from '../descriptor-traits.ts';
import { readyMaterializeAndDeployAppUse } from '@agent-device/contracts/app-deployment-runtime-plan';
import { runtimeCommandRuntimePlanUses } from '@agent-device/contracts/application-lifecycle-runtime-plan';
import { gestureViewportRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import { DEFAULT_TIMEOUT_POLICY } from '../timeout-policy.ts';

/**
 * The daemon-owned control plane (`catalog.group: 'internal'`): the lease routes that hold a
 * cloud session and the internal handlers beside them. Their owner files are daemon handlers,
 * not `src/commands/**`, and none of them is a public CLI verb.
 */
export const INTERNAL_COMMAND_DESCRIPTORS = [
  {
    name: 'human_control',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/daemon/handlers/human-control.ts'] as const } : {}),
    catalog: { group: 'internal', key: 'humanControl' },
    recordsSessionAction: false,
    daemon: {
      route: 'humanControl',
      refFrameEffect: 'preserve',
      selectorValidationExempt: true,
      skipSessionlessProviderDevice: allowAnyDeviceSessionless,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  // -- lease (route: lease) --
  {
    name: 'lease_allocate',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/daemon/handlers/lease.ts'] as const } : {}),
    catalog: { group: 'internal', key: 'leaseAllocate' },
    recordsSessionAction: false,
    daemon: {
      route: 'lease',
      refFrameEffect: 'preserve',
      ...ADMISSION_AND_LOCK_EXEMPT,
    },
    timeoutPolicy: LEASE_ALLOCATE_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'lease_heartbeat',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/daemon/handlers/lease.ts'] as const } : {}),
    catalog: { group: 'internal', key: 'leaseHeartbeat' },
    recordsSessionAction: false,
    daemon: {
      route: 'lease',
      refFrameEffect: 'preserve',
      ...ADMISSION_AND_LOCK_EXEMPT,
    },
    timeoutPolicy: LEASE_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'lease_release',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled ? { ownerFiles: ['src/daemon/handlers/lease.ts'] as const } : {}),
    catalog: { group: 'internal', key: 'leaseRelease' },
    recordsSessionAction: false,
    daemon: {
      route: 'lease',
      refFrameEffect: 'preserve',
      ...ADMISSION_AND_LOCK_EXEMPT,
    },
    timeoutPolicy: LEASE_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  // -- session (route: session) --
  {
    name: 'session_list',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled
      ? { ownerFiles: ['src/daemon/session-lifecycle/internal/inventory.ts'] as const }
      : {}),
    catalog: { group: 'internal', key: 'sessionList' },
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'inventory',
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'session_save_script',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled
      ? { ownerFiles: ['src/daemon/handlers/session-script-publication.ts'] as const }
      : {}),
    catalog: { group: 'internal', key: 'sessionSaveScript' },
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      sessionKind: 'publication',
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
  {
    name: 'runtime',
    deviceClaimPolicy: 'require-owner',
    ...(ownerFilesEnabled
      ? {
          ownerFiles: [
            'src/daemon/handlers/session-runtime-command.ts',
            'src/daemon/handlers/session-runtime-port-reverse.ts',
          ] as const,
        }
      : {}),
    catalog: { group: 'internal' },
    recordsSessionAction: false,
    daemon: { route: 'session', refFrameEffect: 'preserve' },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: {
      kind: 'device-runtime',
      uses: [...runtimeCommandRuntimePlanUses, gestureViewportRuntimeUse],
    },
  },
  {
    name: 'install_source',
    deviceClaimPolicy: 'transient-exclusive',
    ...(ownerFilesEnabled
      ? { ownerFiles: ['src/daemon/handlers/session-app-source-deployment.ts'] as const }
      : {}),
    catalog: { group: 'internal', key: 'installSource' },
    recordsSessionAction: true,
    recordingEffect: 'mutates-app',
    daemon: { route: 'session', refFrameEffect: 'may-invalidate' },
    platformExecution: { kind: 'device-runtime', use: readyMaterializeAndDeployAppUse },
    timeoutPolicy: INSTALL_TIMEOUT_POLICY,
    batchable: false,
  },
  {
    name: 'release_materialized_paths',
    deviceClaimPolicy: 'none',
    ...(ownerFilesEnabled
      ? { ownerFiles: ['src/daemon/handlers/session-app-source-deployment.ts'] as const }
      : {}),
    catalog: { group: 'internal', key: 'releaseMaterializedPaths' },
    recordsSessionAction: false,
    daemon: {
      route: 'session',
      refFrameEffect: 'preserve',
      ...REQUEST_EXECUTION_EXEMPT,
    },
    timeoutPolicy: DEFAULT_TIMEOUT_POLICY,
    batchable: false,
    platformExecution: NO_PLATFORM_EXECUTION,
  },
] as const satisfies readonly RawCommandDescriptor[];
