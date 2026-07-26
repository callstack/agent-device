export function extractCommands(raw) {
  const json = parseJsonPayload(raw);
  if (json && Array.isArray(json.commands)) {
    return json.commands.map((command) => String(command).trim()).filter(Boolean);
  }
  return raw
    .split('\n')
    .map((line) => line.replace(/^[-*\d.]+\s*/, '').trim())
    .filter(
      (line) =>
        line.startsWith('agent-device ') || line.match(/^(open|snapshot|press|fill|click|close)\b/),
    );
}

export function detectRunnerError(raw) {
  if (raw.trim().length === 0) return 'Runner returned empty output.';
  const payload = parseJsonEnvelope(raw);
  if (!isErrorPayload(payload)) return undefined;
  return errorPayloadMessage(payload);
}

function isErrorPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (Array.isArray(payload.commands)) return false;
  return payload.is_error === true || payload.type === 'error' || payload.status === 'failed';
}

function errorPayloadMessage(payload) {
  const nestedError = payload.error;
  const candidates = [
    payload.result,
    payload.message,
    typeof nestedError === 'object' && nestedError ? nestedError.message : nestedError,
  ];
  return (
    candidates.find((value) => typeof value === 'string' && value.trim().length > 0) ??
    'Runner returned an error payload.'
  );
}

function parseJsonPayload(raw) {
  for (const candidate of jsonPayloadCandidates(raw)) {
    const parsed = parseJsonCandidate(candidate);
    if (parsed !== undefined) return normalizeParsedJson(parsed);
  }
  return null;
}

function parseJsonEnvelope(raw) {
  for (const candidate of jsonPayloadCandidates(raw)) {
    const parsed = parseJsonCandidate(candidate);
    if (parsed !== undefined) return parsed;
  }
  return null;
}

function jsonPayloadCandidates(raw) {
  return [raw, raw.match(/```json\s*([\s\S]*?)```/)?.[1], raw.match(/\{[\s\S]*\}/)?.[0]].filter(
    Boolean,
  );
}

function parseJsonCandidate(candidate) {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

function normalizeParsedJson(parsed) {
  if (typeof parsed?.result === 'string') return parseJsonPayload(parsed.result);
  return parsed;
}
