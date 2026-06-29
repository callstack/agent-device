import type { SessionAction } from '../../daemon/types.ts';
import { AppError } from '../../kernel/errors.ts';
import {
  action,
  assertOnlyKeys,
  isPlainRecord,
  requireAppId,
  resolveMaestroString,
  unsupportedMaestroSyntax,
} from './support.ts';
import type { MaestroFlowConfig, MaestroParseContext } from './types.ts';

export function convertLaunchApp(
  value: unknown,
  config: MaestroFlowConfig,
  context: MaestroParseContext,
): SessionAction {
  if (value === null || value === undefined) {
    return action('open', [resolveMaestroString(requireAppId(config, 'launchApp'), context)]);
  }
  if (typeof value === 'string') return action('open', [resolveMaestroString(value, context)]);
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'launchApp expects a string or map.');
  }
  assertOnlyKeys(value, 'launchApp', [
    'appId',
    'stopApp',
    'clearState',
    'clearKeychain',
    'arguments',
    'permissions',
    'launchArguments',
  ]);
  rejectUnsupportedLaunchOption(value, 'permissions');
  rejectUnsupportedLaunchOption(value, 'clearKeychain');
  const appId = resolveMaestroString(
    typeof value.appId === 'string' ? value.appId : requireAppId(config, 'launchApp'),
    context,
  );
  const launchArgs = readLaunchArgs(value, context);
  const shouldClearState = value.clearState === true;
  const shouldRelaunch = !shouldClearState && (value.stopApp === true || launchArgs.length > 0);
  return action('open', [appId], {
    ...(shouldRelaunch ? { relaunch: true } : {}),
    ...(shouldClearState ? { clearAppState: true } : {}),
    ...(launchArgs.length > 0 ? { launchArgs } : {}),
  });
}

export function convertStopApp(
  value: unknown,
  config: MaestroFlowConfig,
  context: MaestroParseContext,
): SessionAction {
  if (value === null || value === undefined) {
    return action('close', [resolveMaestroString(requireAppId(config, 'stopApp'), context)]);
  }
  if (typeof value === 'string') return action('close', [resolveMaestroString(value, context)]);
  throw new AppError('INVALID_ARGS', 'stopApp expects a string appId or no value.');
}

function readLaunchArgs(value: Record<string, unknown>, context: MaestroParseContext): string[] {
  return [
    ...readLaunchArgValue(value.arguments, 'launchApp.arguments', context),
    ...readLaunchArgValue(value.launchArguments, 'launchApp.launchArguments', context),
  ];
}

function readLaunchArgValue(value: unknown, name: string, context: MaestroParseContext): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [resolveMaestroString(value, context)];
  if (Array.isArray(value)) {
    return value.map((entry, index) => readLaunchArgScalar(entry, `${name}[${index}]`, context));
  }
  if (isPlainRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) => [
      resolveMaestroString(key, context),
      readLaunchArgScalar(entry, `${name}.${key}`, context),
    ]);
  }
  throw new AppError('INVALID_ARGS', `${name} expects a string, list, or map.`);
}

function readLaunchArgScalar(value: unknown, name: string, context: MaestroParseContext): string {
  if (typeof value === 'string') return resolveMaestroString(value, context);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new AppError('INVALID_ARGS', `${name} must be a string, number, or boolean.`);
}

function rejectUnsupportedLaunchOption(value: Record<string, unknown>, key: string): void {
  if (value[key] !== undefined) {
    throw unsupportedMaestroSyntax(`Maestro launchApp field "${key}" is not supported yet.`);
  }
}
