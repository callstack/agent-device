import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads the two Swift declarations that decide how a command charge settles (#2965), so the daemon's
 * rules and the runner's cannot drift apart silently. These are source inspections on purpose: the
 * Swift answers they name run on a device lane, so the tie that keeps one claim has to read the
 * declaration rather than a second copy of its answer.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SWIFT_TRANSPORT = path.resolve(
  here,
  '../../../../../apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+Transport.swift',
);
const SWIFT_JOURNAL = path.resolve(
  here,
  '../../../../../apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandJournal.swift',
);

/** `inlineResponse(for:)`'s switch arms, up to the `default:` where queued commands begin. */
const INLINE_SWITCH =
  /func inlineResponse\(for command: Command\)[\s\S]*?switch command\.command \{([\s\S]*?)\n\s*default:/;
/**
 * One unguarded `case .a, .b:` header, bindings continuing across lines if needed. Each repetition
 * must carry its own comma and `.name`, so no two splits of the same text both match — an ambiguous
 * separator like `\s*,?\s*` backtracks exponentially on a long arm list. Requiring the closing colon
 * is what makes a guarded arm (`case .uptime where flag:`) fail the count below rather than read as
 * inline: a guard can fall through to `default:`, so such a command really is queued.
 */
const CASE_HEADER = /\bcase\s+(\.\w+(?:\s*,\s*\.\w+)*):/g;

/**
 * The commands `inlineResponse(for:)` answers without journaling them or putting them on the serial
 * command queue, which is exactly why a reply to one is no evidence about queued work.
 *
 * A reader here can only fail in two directions, and each is caught: a misread that names an extra
 * command fails `runner-readiness-routing.test.ts`, which compares this list against the daemon's
 * `readinessProbe` trait in both directions, and a misread that loses an arm makes a real probe look
 * queued, which that same tie reports. What is left to guard locally is the case both miss — a `case`
 * these two patterns do not recognize, which would otherwise drop an arm and leave a set that still
 * happens to match the trait. That is why a header must end at its colon: a guarded arm
 * (`case .uptime where flag:`) can fall through to `default:`, so it names a command that is really
 * queued some of the time, and it has to fail here rather than read as inline.
 */
export function readSwiftInlineCommands(): string[] {
  const swift = fs.readFileSync(SWIFT_TRANSPORT, 'utf8');
  const body = INLINE_SWITCH.exec(swift)?.[1];
  assert.ok(
    body !== undefined,
    'inlineResponse(for:) must keep a `switch command.command` with a default: arm, which is where ' +
      'queued commands begin. Without that shape there is no inline set to read.',
  );

  const headers = [...body.matchAll(CASE_HEADER)];
  // Every `case` keyword in the switch must belong to a header this reader parsed. An enum-qualified
  // or guarded arm matches neither, and reading the switch without it would silently understate the
  // inline set.
  const caseKeywords = body.match(/\bcase\b/g) ?? [];
  assert.equal(
    headers.length,
    caseKeywords.length,
    'inlineResponse(for:) has a `case` form this reader does not recognize (an enum-qualified or ' +
      'guarded arm?). Name it here before it decides a handoff.',
  );
  const arms: string[] = [];
  for (const [, header] of headers) {
    for (const [, name] of (header ?? '').matchAll(/\.(\w+)/g)) arms.push(name!);
  }
  assert.ok(arms.length > 0, 'inlineResponse(for:) declares no inline command arms');
  return arms;
}

/**
 * The states `RunnerCommandLifecycleState` declares. `completed` and `failed` are written when the
 * journal closes a command — by its response's `ok` in `finish`, or by a thrown error in `fail` — while
 * `accepted` and `started` are written as execution opens. `notAccepted` is never written to an entry:
 * `status` synthesizes it for an id the journal does not hold.
 */
function readSwiftLifecycleStates(): string[] {
  const swift = fs.readFileSync(SWIFT_JOURNAL, 'utf8');
  const declaration = swift.match(/enum RunnerCommandLifecycleState: String \{([\s\S]*?)\n\}/);
  const states = declaration?.[1];
  assert.ok(
    states,
    'RunnerTests+CommandJournal.swift must declare RunnerCommandLifecycleState with a body',
  );
  return [...states.matchAll(/^\s*case\s+(\w+)/gm)].map(([, name]) => name as string);
}

/** One row of the settlement table the daemon must honor for a journal state. */
export type RunnerLifecycleSettlementRow = Readonly<{
  lifecycleState: string;
  /** Whether a terminal verdict for the command may discharge its abandoned charge. */
  settlesCharge: boolean;
}>;

/**
 * Every state the journal declares, each with the settlement the daemon owes it. A state the runner
 * gains without a row here fails the caller, because an unread state would otherwise decide a runner's
 * handoff by accident.
 */
export function requireLifecycleSettlementRows(
  expectations: Readonly<Record<string, boolean>>,
): RunnerLifecycleSettlementRow[] {
  const states = readSwiftLifecycleStates();
  const unruled = states.filter((state) => expectations[state] === undefined);
  assert.deepEqual(
    unruled,
    [],
    `the runner journal declares lifecycle state(s) ${unruled.join(', ')} that the daemon's ` +
      'settlement table has no row for. Name the verdict the charge accounting must reach for it.',
  );
  const unobserved = Object.keys(expectations).filter((state) => !states.includes(state));
  assert.deepEqual(
    unobserved,
    [],
    `the daemon's settlement table rules on state(s) ${unobserved.join(', ')} the runner journal no ` +
      'longer reports. Remove the row or restore the state.',
  );
  return states.map((lifecycleState) => ({
    lifecycleState,
    settlesCharge: expectations[lifecycleState]!,
  }));
}
