export { createAgentDeviceClient } from '@agent-device/client';
export { ensureDaemon } from './ensure-daemon.ts';
export {
  AppError,
  isAgentDeviceError,
  normalizeAgentDeviceError,
} from '@agent-device/kernel/errors';
export type { AgentDeviceClient } from '@agent-device/command-surface';
export type {
  CaptureScreenshotResult,
  CaptureSnapshotResult,
  DeviceBootOptions,
  LeaseAllocateOptions,
  LeaseScopedOptions,
  PressOptions,
} from '@agent-device/contracts/client';
export type { SnapshotNode } from '@agent-device/kernel/snapshot';
