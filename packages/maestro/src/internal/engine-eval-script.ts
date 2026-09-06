import vm from 'node:vm';
import { AppError, errorMessage } from '@agent-device/kernel/errors';

const MAESTRO_EVAL_SCRIPT_TIMEOUT_MS = 10_000;
const UNSAFE_OUTPUT_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

// Maestro evaluates evalScript inside its flow JS context, where env values stay
// real JS values. This engine keeps every variable as a flat string, so it
// evaluates the expression in `node:vm` (trusted flow code, like runScript) and
// folds the assigned `output` object back into string leaves that the flat-key
// interpolator can read — `${output.uppercaseName}` and `${output.list.length}`
// both resolve, which is the same surface the corpus flow exercises.
export function evaluateMaestroEvalScript(
  script: string,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const output = seedMaestroOutput(values);
  const expression = unwrapMaestroEvalScriptExpression(script);
  try {
    vm.runInNewContext(
      expression,
      { ...values, output },
      {
        filename: 'evalScript',
        timeout: MAESTRO_EVAL_SCRIPT_TIMEOUT_MS,
      },
    );
  } catch (error) {
    // A vm context throws its own realm's errors, which are not host `Error`
    // instances; read the message directly rather than through normalizeError.
    throw new AppError(
      'COMMAND_FAILED',
      `Maestro evalScript failed: ${errorMessage(error)}`,
      undefined,
      error instanceof Error ? error : undefined,
    );
  }
  return flattenMaestroOutput(output);
}

function unwrapMaestroEvalScriptExpression(script: string): string {
  const trimmed = script.trim();
  return trimmed.startsWith('${') && trimmed.endsWith('}') ? trimmed.slice(2, -1) : trimmed;
}

// Prior `output.*` leaves become an `output` sandbox object so a chained
// evalScript can read them. Leaves are strings (runScript parity); numeric
// re-interpolation across steps loses JS typing, noted at the flatten gate.
function seedMaestroOutput(values: Readonly<Record<string, string>>): Record<string, unknown> {
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith('output.') || key === 'output') continue;
    writeNestedOutput(output, key.slice('output.'.length), value);
  }
  return output;
}

function writeNestedOutput(root: Record<string, unknown>, path: string, value: string): void {
  const segments = path.split('.').filter(isSafeOutputSegment);
  if (segments.length === 0) return;
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    if (child === null || typeof child !== 'object') {
      node[segment] = Object.create(null) as Record<string, unknown>;
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[segments.at(-1)!] = value;
}

function flattenMaestroOutput(output: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {};
  const visited = new Set<object>();
  writeOutputLeaves(output, [], flat, visited);
  return flat;
}

function writeOutputLeaves(
  value: unknown,
  segments: readonly string[],
  flat: Record<string, string>,
  visited: Set<object>,
): void {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object') {
    flat[`output${segments.map((segment) => `.${segment}`).join('')}`] =
      stringifyOutputValue(value);
    return;
  }
  if (visited.has(value)) return;
  visited.add(value);
  const children = Array.isArray(value)
    ? [...value.keys(), 'length']
    : Object.keys(value).filter(isSafeOutputSegment);
  for (const segment of children) {
    const key = String(segment);
    const child =
      Array.isArray(value) && key === 'length'
        ? value.length
        : (value as Record<string, unknown>)[key];
    writeOutputLeaves(child, [...segments, key], flat, visited);
  }
}

function isSafeOutputSegment(segment: string): boolean {
  return !UNSAFE_OUTPUT_SEGMENTS.has(segment);
}

function stringifyOutputValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
