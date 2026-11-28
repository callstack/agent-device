export const provider = 'saucelabs';
const FILE_ID = '0b6a3f52-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
export const args = [
  '--platform',
  'android',
  '--device',
  'Google Pixel 8',
  '--provider-os-version',
  '14',
  '--provider-app',
  `storage:${FILE_ID}`,
];
export function environment() {
  return { SAUCE_USERNAME: 'user', SAUCE_ACCESS_KEY: 'key' };
}
export function respond(url, rejectCredentials) {
  if (rejectCredentials) return { status: 401, body: { detail: 'Authorization failed' } };
  if (url.startsWith('/v1/rdc/devices'))
    return {
      body: [
        { id: 'Google_Pixel_8_14_real', name: 'Google Pixel 8', os: 'ANDROID', osVersion: '14' },
      ],
    };
  return {
    body: {
      items: [{ id: FILE_ID, name: 'app.apk', kind: 'android', upload_timestamp: 1 }],
      links: { next: null },
      total_items: 1,
    },
  };
}

export const fetchRedirects = ['https://api.us-west-1.saucelabs.com'];
