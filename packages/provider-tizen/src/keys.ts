import { NAVIGATION_KEYS, type RemoteKeys } from '@agent-device/tv-cdp';

export const TIZEN_REMOTE_KEYS: RemoteKeys = {
  ...NAVIGATION_KEYS,
  back: { key: 'XF86Back', code: 'XF86Back', keyCode: 10009 },
};
