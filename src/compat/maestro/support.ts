import type { SessionAction } from '../../daemon/types.ts';
import { AppError } from '../../kernel/errors.ts';
import { MAESTRO_COMPAT_TRACKER_URL, MAESTRO_NEW_ISSUE_URL } from './support-matrix.ts';
import type { MaestroCommand, MaestroFlowConfig, MaestroParseContext } from './types.ts';

export function action(
  command: string,
  positionals: string[] = [],
  flags?: SessionAction['flags'],
): SessionAction {
  return {
    ts: Date.now(),
    command,
    positionals,
    flags: flags ?? {},
  };
}

export function assertOnlyKeys(
  value: Record<string, unknown>,
  command: string,
  supportedKeys: readonly string[],
): void {
  const supported = new Set(supportedKeys);
  const unsupported = Object.keys(value).filter((key) => !supported.has(key));
  if (unsupported.length > 0) {
    throw unsupportedMaestroSyntax(
      `Maestro ${command} field "${unsupported[0]}" is not supported yet.`,
    );
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeCommandList(value: unknown[]): MaestroCommand[] {
  return value.map((entry, index) => {
    if (typeof entry === 'string') return entry;
    if (isPlainRecord(entry)) return entry;
    throw new AppError(
      'INVALID_ARGS',
      `Unsupported Maestro command at index ${index + 1}: expected a scalar or one-key map.`,
    );
  });
}

export function normalizePlatform(value: string | undefined): 'android' | 'ios' | undefined {
  if (!value) return undefined;
  return normalizePlatformName(value);
}

export function readEnvMap(value: unknown, name: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', `${name} expects a map.`);
  }
  const env: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      env[key] = String(raw);
    }
  }
  return env;
}

export function readTimeoutMs(value: unknown, fallback: number): number {
  if (isPlainRecord(value) && typeof value.timeout === 'number' && Number.isFinite(value.timeout)) {
    return Math.max(0, Math.floor(value.timeout));
  }
  return fallback;
}

export function requireAppId(config: MaestroFlowConfig, command: string): string {
  if (config.appId) return config.appId;
  throw new AppError('INVALID_ARGS', `${command} requires appId in the Maestro flow config.`);
}

export function requireStringValue(command: string, value: unknown): string {
  if (typeof value === 'string') return value;
  throw new AppError('INVALID_ARGS', `${command} expects a string value.`);
}

export function resolveMaestroString(value: string, context: MaestroParseContext): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(context.env, key)) return match;
    return String(context.env[key]);
  });
}

export function unsupportedCommand(command: string): never {
  throw unsupportedMaestroSyntax(`Maestro command "${command}" is not supported yet.`);
}

export function unsupportedMaestroSyntax(message: string): never {
  throw new AppError(
    'INVALID_ARGS',
    `${message} See supported/unsupported Maestro compatibility at ${MAESTRO_COMPAT_TRACKER_URL}. If this syntax matters for your flows, comment there or open a focused issue at ${MAESTRO_NEW_ISSUE_URL}.`,
  );
}

function normalizePlatformName(value: string): 'android' | 'ios' | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'android') return 'android';
  if (normalized === 'ios') return 'ios';
  return undefined;
}
