import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

// ---------------------------------------------------------------------------
// Source guard: hand-rolled exec failure wraps must not rebuild the
// stdout/stderr/exitCode details trio inline.
//
// normalizeError only surfaces the stderr excerpt for COMMAND_FAILED errors
// whose details carry `processExitError: true`. Before PR #1072 ~49 call sites
// spread the trio by hand and silently missed the flag, so users saw
// "<tool> exited with code N" with no cause. The fix is centralized in
// `execFailureDetails` / `requireExecSuccess` (src/utils/exec.ts); this guard
// keeps new call sites from drifting back to inline spreads.
//
// A site that intentionally rebuilds the trio WITHOUT the flag (reachable at
// exit 0, timeout errors where the message beats the excerpt, nested tool
// payloads) opts out with a `// exec-guard-allow: <reason>` comment directly
// above the `new AppError(` — the reason doubles as documentation.
// ---------------------------------------------------------------------------

const SRC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW_MARKER = 'exec-guard-allow:';
// Longhand `stdout: x.stdout` and shorthand `stdout,` property forms alike.
const TRIO_KEYS = [/\bstdout\s*[:,}]/, /\bstderr\s*[:,}]/, /\bexitCode\s*[:,}]/] as const;
const MAX_CALL_WINDOW = 1_600;

function listSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(fullPath, files);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
    files.push(fullPath);
  }
  return files;
}

// The argument window of a `new AppError(...)` call: from its opening paren to
// the balancing close, capped defensively in case a string literal unbalances
// the parens.
function appErrorCallWindow(source: string, callStart: number): string {
  const openParen = source.indexOf('(', callStart);
  if (openParen === -1) return '';
  let depth = 0;
  const end = Math.min(source.length, openParen + MAX_CALL_WINDOW);
  for (let i = openParen; i < end; i += 1) {
    const char = source[i];
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen, i + 1);
    }
  }
  return source.slice(openParen, end);
}

function hasAllowMarker(source: string, callStart: number): boolean {
  const precedingLines = source.slice(Math.max(0, callStart - 300), callStart);
  return precedingLines.includes(ALLOW_MARKER);
}

function isInlineTrioViolation(source: string, callStart: number): boolean {
  const window = appErrorCallWindow(source, callStart);
  // Stderr enrichment only fires for COMMAND_FAILED; the trio is plain
  // diagnostic context under other codes (and under dynamic code
  // expressions, which are runner/daemon pass-throughs, not exec wraps).
  if (!/^\(\s*'COMMAND_FAILED'/.test(window)) return false;
  if (!TRIO_KEYS.every((key) => key.test(window))) return false;
  if (window.includes('execFailureDetails') || window.includes('requireExecSuccess')) return false;
  return !hasAllowMarker(source, callStart);
}

function collectFileViolations(filePath: string): string[] {
  const source = fs.readFileSync(filePath, 'utf8');
  const violations: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const callStart = source.indexOf('new AppError(', searchFrom);
    if (callStart === -1) return violations;
    searchFrom = callStart + 1;
    if (!isInlineTrioViolation(source, callStart)) continue;
    const line = source.slice(0, callStart).split('\n').length;
    violations.push(`${path.relative(SRC_ROOT, filePath)}:${line}`);
  }
}

test('AppError details never rebuild the exec stdout/stderr/exitCode trio inline', () => {
  const violations = listSourceFiles(SRC_ROOT).flatMap(collectFileViolations);

  assert.deepEqual(
    violations,
    [],
    `Inline exec stdout/stderr/exitCode spreads in AppError details miss the processExitError flag, ` +
      `so normalizeError cannot surface the stderr excerpt. Build the details with ` +
      `execFailureDetails()/requireExecSuccess() from src/utils/exec.ts, or — when the throw is ` +
      `reachable at exit 0 or the excerpt would degrade the message — opt out with a ` +
      `"// ${ALLOW_MARKER} <reason>" comment above the new AppError(...) call. Violations:\n` +
      violations.join('\n'),
  );
});
