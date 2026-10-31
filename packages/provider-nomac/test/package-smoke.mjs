export const provider = 'nomac';
export const args = ['--platform', 'ios', '--device', 'ipad'];
export function environment(endpoint) {
  return { NOMAC_API_KEY: 'nmk_test', NOMAC_API_URL: endpoint };
}
export function respond(url, rejectCredentials) {
  if (!url.startsWith('/api/v1/simulator/sessions'))
    return { status: 404, body: { error: { code: 'not_found', message: 'No route.' } } };
  return rejectCredentials
    ? { status: 401, body: { error: { code: 'unauthorized', message: 'Invalid API key.' } } }
    : { body: { sessions: [], limit: 100 } };
}
