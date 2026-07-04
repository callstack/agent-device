import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../../kernel/errors.ts';
import type { DefinedEnvMap as EnvMap } from '../../../../utils/env-map.ts';
import { requireExecSuccess } from '../../../../utils/exec.ts';
import { runAppleToolCommand } from '../tool-provider.ts';

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
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9._-]/g, '_');
  const tmpJsonPath = path.join(dir, `AgentDeviceRunner.env.${safeSuffix}.json`);
  const tmpXctestrunPath = path.join(dir, `AgentDeviceRunner.env.${safeSuffix}.xctestrun`);
  const parsed = await readXctestrunPlist(xctestrunPath);

  visitXctestrunTargets(parsed, (target) => mergeEnvIntoXctestrunTarget(target, envVars));
  // Xcode 26.2 can emit attachment lifetime values that differ from the test plan,
  // so normalize the per-session xctestrun immediately before test-without-building.
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
  } catch (err) {
    throw new AppError('COMMAND_FAILED', 'Failed to parse xctestrun JSON', {
      xctestrunPath,
      error: String(err),
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
