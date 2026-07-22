import type { SnapshotResult } from '../core/interactor-types.ts';
import type { CloudWebDriverPlatform } from './runtime.ts';

export type CloudWebDriverOperation =
  | 'lease'
  | 'inventory'
  | 'install'
  | 'open'
  | 'close'
  | 'snapshot'
  | 'screenshot'
  | 'tap'
  | 'doubleTap'
  | 'longPress'
  | 'swipe'
  | 'scroll'
  | 'fill'
  | 'type'
  | 'back'
  | 'home'
  | 'orientation'
  | 'appSwitcher'
  | 'tvRemote'
  | 'clipboard.read'
  | 'clipboard.write'
  | 'settings'
  | 'pinch'
  | 'rotateGesture'
  | 'transformGesture'
  | 'logs'
  | 'record'
  | 'artifacts'
  | 'portReverse'
  | 'nativeSnapshotBackend';

export type CloudWebDriverSupportLevel = 'supported' | 'unsupported';

export type CloudWebDriverOperationCapability = {
  support: CloudWebDriverSupportLevel;
  note?: string;
};

export type CloudWebDriverCapabilityMap = Record<
  CloudWebDriverOperation,
  CloudWebDriverOperationCapability
>;

export type CloudWebDriverProviderCapabilities = {
  provider: string;
  platform: CloudWebDriverPlatform;
  snapshotBackend: Extract<SnapshotResult['backend'], 'android' | 'xctest'>;
  snapshotSource: 'appium-page-source';
  operations: CloudWebDriverCapabilityMap;
};

export type CloudWebDriverCapabilityOverrides = Partial<
  Record<CloudWebDriverOperation, CloudWebDriverSupportLevel | CloudWebDriverOperationCapability>
>;

const supported: CloudWebDriverOperationCapability = { support: 'supported' };
const unsupported: CloudWebDriverOperationCapability = { support: 'unsupported' };

const BASE_WEBDRIVER_CAPABILITIES: CloudWebDriverCapabilityMap = {
  lease: supported,
  inventory: supported,
  install: supported,
  open: supported,
  close: supported,
  snapshot: supported,
  screenshot: supported,
  tap: supported,
  doubleTap: supported,
  longPress: supported,
  swipe: supported,
  scroll: supported,
  fill: supported,
  type: supported,
  back: supported,
  home: supported,
  orientation: supported,
  appSwitcher: supported,
  tvRemote: unsupported,
  'clipboard.read': supported,
  'clipboard.write': supported,
  settings: unsupported,
  pinch: unsupported,
  rotateGesture: unsupported,
  transformGesture: unsupported,
  logs: unsupported,
  record: unsupported,
  artifacts: unsupported,
  portReverse: unsupported,
  nativeSnapshotBackend: {
    support: 'unsupported',
    note: 'Cloud WebDriver cannot upload or run agent-device native runner/helper backends.',
  },
};

export function createCloudWebDriverCapabilities(options: {
  provider: string;
  platform: CloudWebDriverPlatform;
  overrides?: CloudWebDriverCapabilityOverrides;
}): CloudWebDriverProviderCapabilities {
  return {
    provider: options.provider,
    platform: options.platform,
    snapshotBackend: options.platform === 'ios' ? 'xctest' : 'android',
    snapshotSource: 'appium-page-source',
    operations: applyCapabilityOverrides(BASE_WEBDRIVER_CAPABILITIES, options.overrides),
  };
}

export function capabilitySupported(
  capabilities: CloudWebDriverProviderCapabilities,
  operation: CloudWebDriverOperation,
): boolean {
  return capabilities.operations[operation].support !== 'unsupported';
}

export function unsupportedCapabilityMessage(
  capabilities: CloudWebDriverProviderCapabilities,
  operation: CloudWebDriverOperation,
): string {
  const capability = capabilities.operations[operation];
  const note = capability.note ? ` ${capability.note}` : '';
  return `${capabilities.provider} WebDriver runtime does not support ${operation}.${note}`;
}

function applyCapabilityOverrides(
  base: CloudWebDriverCapabilityMap,
  overrides: CloudWebDriverCapabilityOverrides | undefined,
): CloudWebDriverCapabilityMap {
  const next = { ...base };
  for (const [operation, override] of Object.entries(overrides ?? {}) as Array<
    [CloudWebDriverOperation, CloudWebDriverSupportLevel | CloudWebDriverOperationCapability]
  >) {
    next[operation] =
      typeof override === 'string'
        ? { ...base[operation], support: override }
        : { ...base[operation], ...override };
  }
  return next;
}
