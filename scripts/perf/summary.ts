import { PERF_SUMMARY_SCHEMA, type PerfSummary } from './types.ts';

type Json = Record<string, unknown>;

const STAT_FIELDS = ['n', 'mean', 'stddev', 'cv', 'median', 'min', 'max', 'p95'] as const;

function fail(source: string, at: string, expected: string): never {
  throw new Error(`${source}: ${at} must be ${expected}`);
}

function object(value: unknown, source: string, at: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(source, at, 'an object');
  return value as Json;
}

function string(value: unknown, source: string, at: string): string {
  if (typeof value !== 'string') fail(source, at, 'a string');
  return value;
}

function number(value: unknown, source: string, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(source, at, 'a finite number');
  return value;
}

function stat(value: unknown, source: string, at: string): void {
  if (value === null) return;
  const s = object(value, source, at);
  for (const field of STAT_FIELDS) number(s[field], source, `${at}.${field}`);
}

/**
 * Validates a `summary.json` read from disk or a downloaded artifact. Only the fields that the
 * comparison and report read are checked; a run from another schema version is rejected.
 */
export function parsePerfSummary(value: unknown, source: string): PerfSummary {
  const root = object(value, source, 'summary');
  if (root.schema !== PERF_SUMMARY_SCHEMA) fail(source, 'schema', `"${PERF_SUMMARY_SCHEMA}"`);
  if (root.platform !== 'ios' && root.platform !== 'android')
    fail(source, 'platform', 'ios or android');
  string(root.startedAt, source, 'startedAt');
  const config = object(root.config, source, 'config');
  number(config.rounds, source, 'config.rounds');
  const metadata = object(root.metadata, source, 'metadata');
  string(metadata.commit, source, 'metadata.commit');
  string(object(metadata.host, source, 'metadata.host').cpu, source, 'metadata.host.cpu');
  string(object(metadata.device, source, 'metadata.device').name, source, 'metadata.device.name');
  if (!Array.isArray(config.scenarios)) fail(source, 'config.scenarios', 'an array');
  if (!Array.isArray(root.measurements)) fail(source, 'measurements', 'an array');
  root.measurements.forEach((entry, index) => {
    const at = `measurements[${index}]`;
    const m = object(entry, source, at);
    string(m.id, source, `${at}.id`);
    string(m.scenario, source, `${at}.scenario`);
    string(m.command, source, `${at}.command`);
    number(m.failures, source, `${at}.failures`);
    if (!Array.isArray(m.samples)) fail(source, `${at}.samples`, 'an array');
    stat(m.wallClock, source, `${at}.wallClock`);
    stat(m.daemon, source, `${at}.daemon`);
  });
  return value as PerfSummary;
}
