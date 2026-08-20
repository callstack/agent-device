// Discriminated runner outcome (see the companion .d.mts): a raw-string
// success/error split let infrastructure noise (an empty codex payload, a
// Claude is_error envelope) parse as if it were a command plan. Only a
// 'success' outcome carries `commands`, so a caller cannot accidentally score
// a runner-error's raw text against the command validator or expectations.

export function classifyRunnerOutput(raw) {
  if (raw.trim().length === 0) {
    return runnerErrorOutcome(raw, 'Runner returned empty output.', 'empty-output');
  }
  const payload = parseJsonEnvelope(raw);
  if (isErrorPayload(payload)) {
    return runnerErrorOutcome(raw, errorPayloadMessage(payload), 'error-envelope');
  }
  return { kind: 'success', raw, commands: extractCommands(raw) };
}

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

// The RunnerOutcome union's only 'runner-error' constructor: every caller
// that classifies a runner failure (a bad envelope here, a spawn/timeout
// failure in help-conformance-bench.mjs) builds the outcome through this one
// function, so the shape can't drift between the two error sources.
export function runnerErrorOutcome(raw, message, reason) {
  return { kind: 'runner-error', raw, message, reason };
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
