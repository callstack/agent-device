export type EnvMap = Record<string, string | undefined>;
export type DefinedEnvMap = Record<string, string>;
export type TtyLike = { isTTY?: boolean | undefined };

const CI_ENV_MARKERS = [
  'BUILD_ID',
  'BUILD_NUMBER',
  'CI',
  'CI_APP_ID',
  'CI_BUILD_ID',
  'CI_BUILD_NUMBER',
  'CI_NAME',
  'CONTINUOUS_INTEGRATION',
  'RUN_ID',
] as const;

const CI_TRUE_MARKERS = ['GITHUB_ACTIONS', 'BUILDKITE'] as const;

function isCI(env: EnvMap = process.env): boolean {
  if (env.CI === 'false' || env.CI === '0') return false;
  return (
    CI_ENV_MARKERS.some((name) => Boolean(env[name])) ||
    CI_TRUE_MARKERS.some((name) => env[name] === 'true')
  );
}

export function isInteractive(stream: TtyLike, env: EnvMap = process.env): boolean {
  return !isCI(env) && stream.isTTY === true;
}
