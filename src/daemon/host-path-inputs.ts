/**
 * Inputs that name a path on the daemon host. A client of a remote daemon cannot see the host's
 * disk; the only such values it sends are the daemon temp artifact locations the client's own
 * remote rewrite produces, which the daemon then serves back as artifacts.
 */
export const HOST_PATH_INPUT_KEYS = [
  'out',
  'saveScript',
  'sessionSaveScript',
  'baseline',
  'artifactsDir',
  'stepsFile',
  'searchPath',
  'retainPaths',
  'installSource',
  'metroProjectRoot',
  'metroRuntimeFile',
  'iosXctestrunFile',
  'iosXctestDerivedDataPath',
  'iosXctestEnvDir',
  'iosSimulatorDeviceSet',
] as const;
