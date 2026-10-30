export const args = [
  '--platform',
  'ios',
  '--device',
  'iPhone 16',
  '--provider-os-version',
  '18.0',
  '--provider-app',
  'https://apps.example.test/Calculator-simulator.zip',
];
export function environment(endpoint) {
  return { REVYL_API_KEY: 'key', REVYL_API_URL: endpoint };
}
/** The one endpoint `connect revyl`'s verification calls; anything else means a request it must not make. */
const VERIFICATION_PATH = '/api/v1/entity/users/get_user_uuid';

export function respond(url, rejectCredentials) {
  if (new URL(url, 'http://fixture').pathname !== VERIFICATION_PATH) {
    return { status: 404, body: { detail: `Not Found: no route for ${url}` } };
  }
  if (rejectCredentials) return { status: 401, body: { error: 'unauthorized' } };
  return { body: { uuid: '00000000-0000-4000-8000-000000000001' } };
}

export const fetchRedirects = ['https://backend.revyl.ai'];
