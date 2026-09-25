import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { requireExecSuccess, runAppleToolCommand } from './host.ts';

/** The xctestrun plist spells environment blocks as fully defined string maps. */
type EnvMap = Record<string, string>;

/**
 * The name of the per-session `.xctestrun` a runner launch is started with, and the patterns that
 * find that launch again by name.
 *
 * The name reaches `xcodebuild`'s argv as `-xctestrun <dir>/<name>.xctestrun`, and runner cleanup
 * selects the live launch by matching that argv with `pkill -f`: a daemon kills the launches it
 * started itself, and a daemon reclaiming a lease kills another daemon's. The name is therefore a
 * durable process-identity contract, not a scratch filename: renaming it, or reordering the
 * suffix, orphans the xcodebuilds an earlier version started. The daemon-client timeout sweep
 * ships separately and cannot follow a rename, so it pins these bytes as a literal instead of
 * deriving them; its test proves the literal still selects both name eras.
 */
const RUNNER_SESSION_XCTESTRUN_STEM = 'AgentDeviceRunner.env';

/** First field of the session suffix; {@link prepareXctestrunWithEnv} joins it to the stem. */
const SESSION_FIELD_PREFIX = 'session';

/**
 * The session-name prefix as extended-regular-expression source for `pkill -f`, including the
 * separator that follows it. Spelled from the same parts the writer joins, so the filename and its
 * matchers cannot disagree about whether a dot is literal.
 */
const RUNNER_SESSION_XCTESTRUN_NAME_PATTERN = `${escapeForExtendedRegex(
  `${RUNNER_SESSION_XCTESTRUN_STEM}.${SESSION_FIELD_PREFIX}`,
)}-`;

/**
 * Builds the suffix the session writes after the stem: `session-<deviceId>-<ownerToken>-<port>`.
 * Cleanup matches on that exact field order, and the sanitization is what keeps a device id holding
 * a path separator from naming a file the matcher can never select.
 */
export function buildRunnerSessionXctestrunSuffix(
  params: Readonly<{ deviceId: string; ownerToken: string; port: number }>,
): string {
  return sanitizeRunnerSessionNameField(
    `${SESSION_FIELD_PREFIX}-${params.deviceId}-${params.ownerToken}-${params.port}`,
  );
}

/**
 * The `pkill -f` pattern selecting one device's runner launches, for a caller that knows the owner
 * token or does not. Without a token the device is followed by the port — the pre-owner-token
 * spelling, kept matchable because a released version may still hold such a launch.
 */
export function buildRunnerSessionXctestrunCleanupPattern(
  params: Readonly<{ deviceId: string; ownerToken?: string | undefined }>,
): string {
  const deviceId = escapeForExtendedRegex(sanitizeRunnerSessionNameField(params.deviceId));
  const { ownerToken } = params;
  return ownerToken === undefined
    ? `${RUNNER_SESSION_XCTESTRUN_NAME_PATTERN}${deviceId}-[0-9]`
    : `${RUNNER_SESSION_XCTESTRUN_NAME_PATTERN}${deviceId}-${escapeForExtendedRegex(
        sanitizeRunnerSessionNameField(ownerToken),
      )}-`;
}

/** Characters a session name may carry; anything else is flattened, as the filesystem does. */
function sanitizeRunnerSessionNameField(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
}

function escapeForExtendedRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

const RUNNER_XCTESTRUN_CAPTURE_OPTIONS = {
  PreferredScreenCaptureFormat: 'screenshots',
  SystemAttachmentLifetime: 'keepNever',
  UserAttachmentLifetime: 'keepNever',
} as const;

type XctestrunTarget = {
  TestBundlePath?: unknown;
  EnvironmentVariables?: EnvMap;
  UITestEnvironmentVariables?: EnvMap;
  UITargetAppEnvironmentVariables?: EnvMap;
  TestingEnvironmentVariables?: EnvMap;
  [key: string]: unknown;
};
type XctestrunConfig = {
  TestTargets?: unknown;
  [key: string]: unknown;
};
type XctestrunPlist = {
  TestConfigurations?: unknown;
  [key: string]: unknown;
};
type XctestrunTargetVisitOptions = {
  requireTestBundlePath?: boolean;
};
type XctestrunEnvOptions = {
  iosXctestEnvDir?: string;
};

export async function prepareXctestrunWithEnv(
  xctestrunPath: string,
  envVars: Record<string, string>,
  suffix: string,
  options: XctestrunEnvOptions = {},
): Promise<{ xctestrunPath: string; jsonPath: string }> {
  const configuredEnvDir = options.iosXctestEnvDir?.trim();
  const dir = configuredEnvDir ? path.resolve(configuredEnvDir) : path.dirname(xctestrunPath);
  fs.mkdirSync(dir, { recursive: true });
  const safeSuffix = sanitizeRunnerSessionNameField(suffix);
  const tmpJsonPath = path.join(dir, `${RUNNER_SESSION_XCTESTRUN_STEM}.${safeSuffix}.json`);
  const tmpXctestrunPath = path.join(
    dir,
    `${RUNNER_SESSION_XCTESTRUN_STEM}.${safeSuffix}.xctestrun`,
  );
  const parsed = await readXctestrunPlist(xctestrunPath);

  visitXctestrunTargets(parsed, (target) => mergeEnvIntoXctestrunTarget(target, envVars));
  // Xcode re-synthesizes these keys from its own defaults, not the test plan: building this
  // runner's plan (which sets keepNever) still yields SystemAttachmentLifetime=deleteOnSuccess on
  // Xcode 26.2 and 27.1, so a launch that skipped this rewrite would keep a screenshot per test.
  applyRunnerXctestrunCapturePolicy(parsed);
  await writeXctestrunPlist(parsed, tmpJsonPath, tmpXctestrunPath);

  return { xctestrunPath: tmpXctestrunPath, jsonPath: tmpJsonPath };
}

async function readXctestrunPlist(xctestrunPath: string): Promise<XctestrunPlist> {
  const jsonResult = await runAppleToolCommand(
    'plutil',
    ['-convert', 'json', '-o', '-', xctestrunPath],
    {
      allowFailure: true,
    },
  );
  if (jsonResult.exitCode !== 0 || !jsonResult.stdout.trim()) {
    throw new AppError('COMMAND_FAILED', 'Failed to read xctestrun plist', {
      xctestrunPath,
      stderr: jsonResult.stderr,
    });
  }

  try {
    const raw: unknown = JSON.parse(jsonResult.stdout);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Root must be an object');
    }
    return raw as XctestrunPlist;
  } catch (error) {
    throw new AppError('COMMAND_FAILED', 'Failed to parse xctestrun JSON', {
      xctestrunPath,
      error: String(error),
    });
  }
}

async function writeXctestrunPlist(
  parsed: XctestrunPlist,
  tmpJsonPath: string,
  tmpXctestrunPath: string,
): Promise<void> {
  fs.writeFileSync(tmpJsonPath, JSON.stringify(parsed, null, 2));
  requireExecSuccess(
    await runAppleToolCommand('plutil', ['-convert', 'xml1', '-o', tmpXctestrunPath, tmpJsonPath], {
      allowFailure: true,
    }),
    'Failed to write xctestrun plist',
    { tmpXctestrunPath },
  );
}

function mergeEnvIntoXctestrunTarget(
  target: XctestrunTarget,
  envVars: Record<string, string>,
): void {
  target.EnvironmentVariables = { ...(target.EnvironmentVariables ?? {}), ...envVars };
  target.UITestEnvironmentVariables = { ...(target.UITestEnvironmentVariables ?? {}), ...envVars };
  target.UITargetAppEnvironmentVariables = {
    ...(target.UITargetAppEnvironmentVariables ?? {}),
    ...envVars,
  };
  target.TestingEnvironmentVariables = {
    ...(target.TestingEnvironmentVariables ?? {}),
    ...envVars,
  };
}

function applyRunnerXctestrunCapturePolicy(parsed: XctestrunPlist): void {
  visitXctestrunTargets(
    parsed,
    (target) => Object.assign(target, RUNNER_XCTESTRUN_CAPTURE_OPTIONS),
    { requireTestBundlePath: true },
  );
}

function visitXctestrunTargets(
  parsed: XctestrunPlist,
  visit: (target: XctestrunTarget) => void,
  options: XctestrunTargetVisitOptions = {},
): void {
  const configs = parsed.TestConfigurations;
  if (Array.isArray(configs)) {
    for (const config of configs as XctestrunConfig[]) {
      if (!config || typeof config !== 'object') continue;
      visitTargets(config.TestTargets, visit, options);
    }
  }

  for (const value of Object.values(parsed)) {
    const target = toXctestrunTarget(value, { requireTestBundlePath: true });
    if (target) visit(target);
  }
}

function visitTargets(
  targets: unknown,
  visit: (target: XctestrunTarget) => void,
  options: XctestrunTargetVisitOptions,
): void {
  if (!Array.isArray(targets)) return;
  for (const target of targets) {
    const parsed = toXctestrunTarget(target, options);
    if (parsed) visit(parsed);
  }
}

function toXctestrunTarget(
  value: unknown,
  options: XctestrunTargetVisitOptions,
): XctestrunTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value as XctestrunTarget;
  if (options.requireTestBundlePath && !target.TestBundlePath) return null;
  return target;
}
