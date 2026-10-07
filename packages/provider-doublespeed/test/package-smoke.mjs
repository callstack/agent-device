export const args = ['--platform', 'ios'];
export function environment(endpoint) {
  return { DOUBLESPEED_API_KEY: 'key', DOUBLESPEED_API_URL: endpoint };
}
export function respond(_url, rejectCredentials) {
  return rejectCredentials ? { status: 401, body: { error: 'unauthorized' } } : { body: [] };
}
