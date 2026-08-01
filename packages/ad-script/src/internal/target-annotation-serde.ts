/**
 * ADR 0012 decision 3: versioned `.ad` target-binding evidence — the
 * comment-line SERDE half shared by the writer
 * (`src/daemon/session-target-evidence.ts`) and the parser
 * (`packages/ad-script/src/internal/script.ts`). Owns the wire type,
 * canonical field order, normalization, size caps, and payload
 * parsing/validation.
 *
 * The record/replay-shared CLASSIFICATION core (`classifyTargetBindingMatch`,
 * local-identity + ancestry-prefix matching) is not part of this codec — it
 * stays in `src/replay/target-identity.ts`, which imports the types below
 * from this package (#1478 P5 scoping dossier, "the codec seam").
 */

import { AppError } from '@agent-device/kernel/errors';

const TARGET_ANNOTATION_TAG = 'agent-device:target-v1';
// Captures the rest of the line verbatim: a line claiming the tag with a
// garbage payload is a malformed v1 annotation, never an ordinary comment.
//
// The payload group is anchored on `\S` (CodeQL js/polynomial-redos,
// #1536 review): `\s+` and a bare `.*` both accept whitespace, so a run of
// separator characters that ultimately fails to match `$` (e.g. many tabs
// with no trailing content) has exponentially many `\s+`/`.*` splits to
// backtrack through. `\S` is `\s`'s complement, so it can never overlap with
// the mandatory `\s+` before it — the split point is unique, no backtracking
// possible. Behavior-preserving: the only caller (below) always matches
// against an already-`.trim()`-ed line, whose last character (when the tag
// matches at all) is never whitespace, so a payload section that `\S.*`
// would reject (all-whitespace) can never reach this regex in practice.
/** Internal-test visibility only: the pattern itself is the ReDoS regression surface. */
export const TARGET_ANNOTATION_LINE_RE = /^#\s*agent-device:target-v(\d+)(?:\s+(\S.*))?$/;

export const TARGET_ANNOTATION_MAX_FIELD_BYTES = 256;
export const TARGET_ANNOTATION_MAX_PAYLOAD_BYTES = 4096;
export const TARGET_ANNOTATION_MAX_ANCESTRY = 8;

// The annotation SHAPE lives in contracts/ so the recorded-action type can be stated without
// depending on this zone; re-exported here for existing consumers.
export type {
  TargetAncestryEntry,
  TargetAnnotationV1,
  TargetRect,
  TargetScrollRegion,
  TargetVerification,
} from '@agent-device/contracts/replay';
import type {
  TargetAncestryEntry,
  TargetAnnotationV1,
  TargetRect,
  TargetScrollRegion,
  TargetVerification,
} from '@agent-device/contracts/replay';

// ---------------------------------------------------------------------------
// Normalization (decision 3 "Normalization"): all strings NFC; `label` fields
// additionally trim and collapse internal whitespace runs. A string that is
// empty after normalization is omitted (writer) / treated as absent
// (comparator). Applies to every string field: top-level id/role/label,
// ancestry entry role/label, and scrollRegion role/id/label.
// ---------------------------------------------------------------------------

function nfc(value: string): string {
  return value.normalize('NFC');
}

/** id/role fields: NFC only (never trimmed/collapsed — see decision 3). */
export function normalizeIdentifierField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = nfc(value);
  return normalized.length > 0 ? normalized : undefined;
}

/** `role` is always required (may be the empty string per decision 3's ancestry note). */
export function normalizeRoleField(value: string): string {
  return nfc(value);
}

/** label fields: NFC, trim, collapse internal whitespace runs to one space. */
export function normalizeLabelField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = nfc(value).trim().replace(/\s+/g, ' ');
  return collapsed.length > 0 ? collapsed : undefined;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Writer-side field truncation to the 256-byte cap ("per-field truncation",
 * decision 3's writer-parser invariant). Trims on a code-point boundary so a
 * surrogate pair is never split. The parser never calls this — it REJECTS
 * oversized fields instead (see `parseTargetAnnotationV1Payload`).
 */
export function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let end = value.length;
  while (end > 0 && utf8ByteLength(value.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  if (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd8_00 && code <= 0xdb_ff) end -= 1; // don't split a surrogate pair
  }
  return value.slice(0, end);
}

// ---------------------------------------------------------------------------
// Canonical serialization (decision 3's exact field order + nested-object
// key order from the example payload).
// ---------------------------------------------------------------------------

function buildCanonicalTargetAnnotationObject(
  evidence: TargetAnnotationV1,
): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  if (evidence.id !== undefined) obj.id = evidence.id;
  obj.role = evidence.role;
  if (evidence.label !== undefined) obj.label = evidence.label;
  obj.ancestry = evidence.ancestry.map(buildAncestryEntryObject);
  obj.sibling = evidence.sibling;
  obj.viewportOrder = evidence.viewportOrder;
  if (evidence.scrollRegion) obj.scrollRegion = buildScrollRegionObject(evidence.scrollRegion);
  if (evidence.rect) obj.rect = buildRectObject(evidence.rect);
  obj.verification = evidence.verification;
  return obj;
}

function buildAncestryEntryObject(entry: TargetAncestryEntry): Record<string, unknown> {
  const obj: Record<string, unknown> = { role: entry.role };
  if (entry.label !== undefined) obj.label = entry.label;
  return obj;
}

function buildScrollRegionObject(region: TargetScrollRegion): Record<string, unknown> {
  const obj: Record<string, unknown> = { role: region.role };
  if (region.id !== undefined) obj.id = region.id;
  if (region.label !== undefined) obj.label = region.label;
  return obj;
}

function buildRectObject(rect: TargetRect): Record<string, unknown> {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

export function serializeTargetAnnotationV1(evidence: TargetAnnotationV1): string {
  return JSON.stringify(buildCanonicalTargetAnnotationObject(evidence));
}

export function formatTargetAnnotationCommentLine(evidence: TargetAnnotationV1): string {
  return `# ${TARGET_ANNOTATION_TAG} ${serializeTargetAnnotationV1(evidence)}`;
}

// ---------------------------------------------------------------------------
// Parsing (decision 3's parser bullet + "Replay-time verification" intro).
// ---------------------------------------------------------------------------

export type TargetAnnotationLineParseResult =
  | { kind: 'none' }
  | { kind: 'future-version' }
  | { kind: 'v1'; evidence: TargetAnnotationV1 };

/**
 * Recognizes a `# agent-device:target-vN {...}` comment line. `N !== 1` is an
 * ordinary comment to this (v1) reader, per decision 3: "An unknown future
 * `target-vN` comment is an ordinary comment to a v1 reader." Any other `#`
 * line (including one that merely mentions the tag inside prose) is `none`.
 */
export function parseTargetAnnotationCommentLine(rawLine: string): TargetAnnotationLineParseResult {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith('#')) return { kind: 'none' };
  const match = TARGET_ANNOTATION_LINE_RE.exec(trimmed);
  if (!match) return { kind: 'none' };
  const version = Number(match[1]);
  if (version !== 1) return { kind: 'future-version' };
  const evidence = parseTargetAnnotationV1Payload((match[2] ?? '').trim());
  return { kind: 'v1', evidence };
}

/**
 * Parses and validates the JSON payload of a `target-v1` annotation.
 * Accepts known fields in any order, ignores unknown fields, NFC-normalizes
 * known strings, and rejects malformed/oversized payloads with
 * `INVALID_ARGS` (decision 3: "The parser rejects a v1 annotation exceeding
 * these bounds with INVALID_ARGS").
 */
// fallow-ignore-next-line complexity
export function parseTargetAnnotationV1Payload(jsonText: string): TargetAnnotationV1 {
  if (utf8ByteLength(jsonText) > TARGET_ANNOTATION_MAX_PAYLOAD_BYTES) {
    throw new AppError(
      'INVALID_ARGS',
      `target-v1 annotation exceeds the ${TARGET_ANNOTATION_MAX_PAYLOAD_BYTES}-byte payload cap.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new AppError('INVALID_ARGS', 'target-v1 annotation is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('INVALID_ARGS', 'target-v1 annotation must be a JSON object.');
  }
  const raw = parsed as Record<string, unknown>;

  const role = parseRequiredRoleField(raw.role, 'role');
  const id = parseOptionalIdentifierField(raw.id, 'id');
  const label = parseOptionalLabelField(raw.label, 'label');
  const ancestry = parseAncestryField(raw.ancestry);
  const sibling = parseNonNegativeIntField(raw.sibling, 'sibling', 0);
  const viewportOrder = parseNonNegativeIntField(raw.viewportOrder, 'viewportOrder', 0);
  const scrollRegion = parseScrollRegionField(raw.scrollRegion);
  const rect = parseRectField(raw.rect);
  const verification = parseVerificationField(raw.verification);

  return {
    ...(id !== undefined ? { id } : {}),
    role,
    ...(label !== undefined ? { label } : {}),
    ancestry,
    sibling,
    viewportOrder,
    ...(scrollRegion ? { scrollRegion } : {}),
    ...(rect ? { rect } : {}),
    verification,
  };
}

/**
 * The writer emits `role` unconditionally (possibly as the empty string for
 * a typeless node), so a missing role key is always foreign input and is
 * rejected rather than defaulted.
 */
function parseRequiredRoleField(value: unknown, field: string): string {
  if (value === undefined) {
    throw new AppError('INVALID_ARGS', `target-v1 "${field}" is required.`);
  }
  if (typeof value !== 'string') {
    throw new AppError('INVALID_ARGS', `target-v1 "${field}" must be a string.`);
  }
  return boundField(normalizeRoleField(value), field);
}

function parseOptionalIdentifierField(value: unknown, field: 'id'): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AppError('INVALID_ARGS', `target-v1 "${field}" must be a string.`);
  }
  const normalized = normalizeIdentifierField(value);
  return normalized === undefined ? undefined : boundField(normalized, field);
}

function parseOptionalLabelField(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AppError('INVALID_ARGS', `target-v1 "${field}" must be a string.`);
  }
  const normalized = normalizeLabelField(value);
  return normalized === undefined ? undefined : boundField(normalized, field);
}

function boundField(value: string, field: string): string {
  if (utf8ByteLength(value) > TARGET_ANNOTATION_MAX_FIELD_BYTES) {
    throw new AppError(
      'INVALID_ARGS',
      `target-v1 "${field}" exceeds the ${TARGET_ANNOTATION_MAX_FIELD_BYTES}-byte field cap.`,
    );
  }
  return value;
}

function parseAncestryField(value: unknown): TargetAncestryEntry[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'target-v1 "ancestry" must be an array.');
  }
  if (value.length > TARGET_ANNOTATION_MAX_ANCESTRY) {
    throw new AppError(
      'INVALID_ARGS',
      `target-v1 "ancestry" exceeds the ${TARGET_ANNOTATION_MAX_ANCESTRY}-entry cap.`,
    );
  }
  return value.map((entry, index) => parseAncestryEntry(entry, index));
}

function parseAncestryEntry(entry: unknown, index: number): TargetAncestryEntry {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new AppError('INVALID_ARGS', `target-v1 "ancestry[${index}]" must be an object.`);
  }
  const record = entry as Record<string, unknown>;
  const role = parseRequiredRoleField(record.role, `ancestry[${index}].role`);
  const label = parseOptionalLabelField(record.label, `ancestry[${index}].label`);
  return { role, ...(label !== undefined ? { label } : {}) };
}

function parseNonNegativeIntField(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AppError('INVALID_ARGS', `target-v1 "${field}" must be a non-negative integer.`);
  }
  return value;
}

function parseScrollRegionField(value: unknown): TargetScrollRegion | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'target-v1 "scrollRegion" must be an object.');
  }
  const record = value as Record<string, unknown>;
  const role = parseRequiredRoleField(record.role, 'scrollRegion.role');
  const id = parseOptionalIdentifierField(record.id, 'id');
  const label = parseOptionalLabelField(record.label, 'scrollRegion.label');
  return {
    role,
    ...(id !== undefined ? { id } : {}),
    ...(label !== undefined ? { label } : {}),
  };
}

function parseRectField(value: unknown): TargetRect | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'target-v1 "rect" must be an object.');
  }
  const record = value as Record<string, unknown>;
  const x = parseFiniteNumberField(record.x, 'rect.x');
  const y = parseFiniteNumberField(record.y, 'rect.y');
  const width = parseFiniteNumberField(record.width, 'rect.width');
  const height = parseFiniteNumberField(record.height, 'rect.height');
  return { x, y, width, height };
}

function parseFiniteNumberField(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('INVALID_ARGS', `target-v1 "${field}" must be a finite number.`);
  }
  return value;
}

function parseVerificationField(value: unknown): TargetVerification {
  if (value === 'verified' || value === 'unverifiable') return value;
  throw new AppError(
    'INVALID_ARGS',
    'target-v1 "verification" must be "verified" or "unverifiable".',
  );
}
