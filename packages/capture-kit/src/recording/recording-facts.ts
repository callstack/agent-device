import {
  isRecordingExportQuality,
  isRecordingScope,
  type RecordingAppIdentity,
  type RecordingExportQuality,
  type RecordingScope,
} from '@agent-device/contracts/recording';
import { isRecord } from '@agent-device/kernel/record';

/**
 * What a durable recording keeps about what its caller asked for, apart from where its files live
 * (ADR 0024 2.3). Every backend's descriptor carries these facts because the export it owes the
 * caller is described by them, so one validator decides whether a manifest's copy can be trusted
 * rather than each backend inventing its own strictness.
 */
export type RecordingFacts = Readonly<{
  scope: RecordingScope;
  showTouches: boolean;
  recordOnlySession: boolean;
  activeSessionApp?: RecordingAppIdentity;
  exportQuality?: RecordingExportQuality;
}>;

/** The keys of {@link RecordingFacts}, so a backend carries the facet without naming it twice. */
export const RECORDING_FACTS_KEYS = [
  'scope',
  'showTouches',
  'recordOnlySession',
  'activeSessionApp',
  'exportQuality',
] as const satisfies readonly (keyof RecordingFacts)[];

/**
 * Whether a durable value carries whole recording facts. One unreadable field refuses the whole
 * facet: a resumed stop that trusted half an overlay request would serve a video the caller never
 * asked for, which is the failure an unreadable descriptor is supposed to prevent.
 */
export function recordingFactsAreValid(value: Record<string, unknown>): value is RecordingFacts {
  return (
    isRecordingScope(value.scope) &&
    typeof value.showTouches === 'boolean' &&
    typeof value.recordOnlySession === 'boolean' &&
    (value.exportQuality === undefined || isRecordingExportQuality(value.exportQuality)) &&
    isOptionalAppIdentity(value.activeSessionApp)
  );
}

function isOptionalAppIdentity(value: unknown): value is RecordingAppIdentity | undefined {
  if (value === undefined) return true;
  if (!isRecord(value) || !isNonemptyText(value.bundleId)) return false;
  return value.name === undefined || isNonemptyText(value.name);
}

function isNonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
