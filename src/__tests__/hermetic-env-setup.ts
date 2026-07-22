// Unit tests must be hermetic with respect to the host's daemon-connection
// environment. A machine actually running agent-device — including this repo's
// own remote dev containers — exports AGENT_DEVICE_DAEMON_BASE_URL and
// AGENT_DEVICE_DAEMON_AUTH_TOKEN pointing at a live daemon. Production
// flag-default resolution folds those into every command's input and connection
// config (resolveConfigBackedFlagDefaults -> readEnvFlagDefaults, and the daemon
// client's own env fallbacks), so a configured host silently diverges from CI:
// tests that assert an exact command input/config shape gain phantom
// daemonBaseUrl/daemonAuthToken keys, and daemon-client tests take the remote
// path ("Remote daemon is unavailable") instead of the local one they exercise.
//
// CI runs with these unset. Delete them here so a configured host matches CI.
// Tests that genuinely need them assign their own value or pass an explicit env
// object; that happens inside the test, after this module has loaded, so this
// scrub does not interfere.
const AMBIENT_DAEMON_ENV_VARS = [
  'AGENT_DEVICE_DAEMON_BASE_URL',
  'AGENT_DEVICE_DAEMON_AUTH_TOKEN',
] as const;

for (const name of AMBIENT_DAEMON_ENV_VARS) {
  delete process.env[name];
}
