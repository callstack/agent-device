export const provider = 'browserstack';
export const additionalExports = {
  './connection-verification': { import: './dist/connection-verification.mjs' },
  './package.json': './package.json',
};
export const args = [
  '--platform',
  'android',
  '--device',
  'Google Pixel 8',
  '--provider-os-version',
  '14.0',
  '--provider-app',
  'bs://app-id',
];
export function environment() {
  return { BROWSERSTACK_USERNAME: 'user', BROWSERSTACK_ACCESS_KEY: 'key' };
}
export function respond(url, rejectCredentials) {
  const pathname = new URL(url, 'http://fixture').pathname;
  if (!['/app-automate/devices.json', '/app-automate/recent_apps'].includes(pathname)) {
    return { status: 404, body: { error: 'not-found' } };
  }
  if (rejectCredentials) return { status: 401, body: { error: 'unauthorized' } };
  return pathname === '/app-automate/devices.json'
    ? { body: [{ os: 'android', os_version: '14.0', device: 'Google Pixel 8', realMobile: true }] }
    : { body: [{ app_name: 'app.apk', app_version: '1.0', app_url: 'bs://app-id' }] };
}

export const fetchRedirects = ['https://api-cloud.browserstack.com'];
