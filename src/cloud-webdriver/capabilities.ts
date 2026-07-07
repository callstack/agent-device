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
  | 'rotate'
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

export type CloudWebDriverSupportLevel = 'supported' | 'partial' | 'unsupported';

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
  inventory: {
    support: 'partial',
    note: 'Inventory exposes only the leased cloud device, not the provider catalog.',
  },
  install: {
    support: 'partial',
    note: 'Requires provider-specific upload or a path visible to the remote Appium server.',
  },
  open: supported,
  close: supported,
  snapshot: {
    support: 'partial',
    note: 'Uses Appium page source XML, not agent-device native snapshot backends.',
  },
  screenshot: supported,
  tap: supported,
  doubleTap: supported,
  longPress: supported,
  swipe: supported,
  scroll: {
    support: 'partial',
    note: 'Implemented as viewport-relative W3C pointer gestures.',
  },
  fill: supported,
  type: supported,
  back: supported,
  home: {
    support: 'partial',
    note: 'Uses provider/Appium mobile pressButton support where available.',
  },
  rotate: {
    support: 'partial',
    note: 'Uses provider/Appium mobile rotate support where available.',
  },
  appSwitcher: {
    support: 'partial',
    note: 'Uses provider/Appium mobile pressButton support where available.',
  },
  tvRemote: unsupported,
  'clipboard.read': {
    support: 'partial',
    note: 'Uses provider/Appium clipboard extension support where available.',
  },
  'clipboard.write': {
    support: 'partial',
    note: 'Uses provider/Appium clipboard extension support where available.',
  },
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
