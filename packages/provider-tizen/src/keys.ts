import { MEDIA_KEYS, NAVIGATION_KEYS, type RemoteKeys } from '@agent-device/tv-cdp';

export const TIZEN_REMOTE_KEYS: RemoteKeys = {
  ...NAVIGATION_KEYS,
  back: { key: 'XF86Back', code: 'XF86Back', keyCode: 10009 },
  'media-play-pause': { key: 'MediaPlayPause', code: 'MediaPlayPause', keyCode: 10252 },
  'media-next': { key: 'MediaTrackNext', code: 'MediaTrackNext', keyCode: 10233 },
  'media-previous': { key: 'MediaTrackPrevious', code: 'MediaTrackPrevious', keyCode: 10232 },
  ...MEDIA_KEYS,
};
