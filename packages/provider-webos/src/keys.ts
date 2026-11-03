import { NAVIGATION_KEYS, type RemoteKeys } from '@agent-device/tv-cdp';

export const WEBOS_REMOTE_KEYS: RemoteKeys = {
  ...NAVIGATION_KEYS,
  back: { key: 'GoBack', code: 'BrowserBack', keyCode: 461 },
};
