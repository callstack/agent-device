// The public API vocabulary for what a device and an open session look like to a client.

import type { AppleOS, DeviceKind, DeviceTarget, PublicPlatform } from '../kernel/device.ts';
import type { AgentDeviceIdentifiers, DeviceCommandBaseOptions } from './client-connection.ts';

export type AgentDeviceDevice = {
  platform: PublicPlatform;
  target: DeviceTarget;
  kind: DeviceKind;
  id: string;
  name: string;
  booted?: boolean;
  /**
   * Additive Apple-OS discriminant (iPhone/iPad/tvOS/visionOS/macOS). Present only for
   * Apple devices; `platform` still carries the leaf (`ios`/`macos`).
   */
  appleOs?: AppleOS;
  identifiers: AgentDeviceIdentifiers;
  ios?: {
    udid: string;
  };
  android?: {
    serial: string;
  };
  vega?: {
    serial: string;
  };
};

export type AgentDeviceCapabilitiesResult = {
  device: AgentDeviceDevice;
  availableCommands: string[];
};

export type AgentDeviceSessionDevice = {
  platform: PublicPlatform;
  target: DeviceTarget;
  id: string;
  name: string;
  /**
   * Additive Apple-OS discriminant (iPhone/iPad/tvOS/visionOS/macOS). Present only for
   * Apple devices; `platform` still carries the leaf (`ios`/`macos`).
   */
  appleOs?: AppleOS;
  identifiers: AgentDeviceIdentifiers;
  ios?: {
    udid: string;
    simulatorSetPath?: string | null;
  };
  android?: {
    serial: string;
  };
  vega?: {
    serial: string;
  };
};

export type AgentDeviceSession = {
  name: string;
  createdAt: number;
  sessionStateDir?: string;
  runnerLogPath?: string;
  device: AgentDeviceSessionDevice;
  identifiers: AgentDeviceIdentifiers;
};

export type StartupPerfSample = {
  durationMs: number;
  measuredAt: string;
  method: string;
  appTarget?: string;
  appBundleId?: string;
};

export type DeviceBootOptions = DeviceCommandBaseOptions & {
  headless?: boolean;
};

export type DeviceShutdownOptions = DeviceCommandBaseOptions;
