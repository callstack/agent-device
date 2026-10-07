export const args = [
  '--platform',
  'android',
  '--device',
  'Pixel 8',
  '--provider-os-version',
  '14',
  '--provider-app',
  'lt://APP1',
];
export function environment(endpoint) {
  return { LT_USERNAME: 'user', LT_ACCESS_KEY: 'key', TESTMU_API_ENDPOINT: endpoint };
}
export function respond(url, rejectCredentials) {
  if (url.includes('capability/generator'))
    return {
      body: {
        app: {
          devices: { android: { brands: { Google: [{ name: 'Pixel 8', osVersion: ['14'] }] } } },
        },
      },
    };
  return rejectCredentials
    ? { status: 401, body: { error: 'unauthorized' } }
    : {
        body: {
          data: [{ app_id: 'APP1', name: 'app.apk', type: 'android' }],
          metaData: { total: 1 },
        },
      };
}

export const fetchRedirects = ['https://manual-api.lambdatest.com'];
