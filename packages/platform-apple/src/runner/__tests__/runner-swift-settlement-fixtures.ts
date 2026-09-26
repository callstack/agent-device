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

/**
 * The command names in `inlineResponse(for:)`'s switch, up to its `default:` arm. The runner answers
 * these outside its journal and off the serial command queue, which is exactly why a reply to one is
 * no evidence about queued work.
 */
export function readSwiftInlineCommands(): string[] {
  const swift = fs.readFileSync(SWIFT_TRANSPORT, 'utf8');
  const { arms, sawDefault } = parseSwiftInlineCommandArms(swift);
  assert.ok(
    sawDefault,
    'inlineResponse(for:) must keep its default: arm, which is where queued commands begin',
  );
  assert.ok(arms.length > 0, 'inlineResponse(for:) declares no inline command arms');
  return arms;
}

/**
 * The arms of `inlineResponse(for:)`'s `switch command.command`, at the switch's own depth, and
 * whether a `default:` arm ended them.
 *
 * Scanned over a copy of the source with strings and comments blanked, not line by line: a line-based
 * reader would silently drop arms for the shapes this is documented to survive — a `case .a,` header
 * continued on the next line, a body brace opened on the header line, a brace or a `case`/`default:`
 * word inside a string or comment — and every one of those failures shrinks the set the daemon's
 * trait is checked against, which is the exact drift this tie exists to catch. A raw string (`#"…"#`)
 * is not modeled; one appearing here would trip the caller's own assertions rather than read short.
 */
export function parseSwiftInlineCommandArms(source: string): {
  arms: string[];
  sawDefault: boolean;
} {
  const code = blankSwiftStringsAndComments(source);
  const arms: string[] = [];
  let sawDefault = false;
  let index = swiftInlineSwitchStart(code);
  let depth = 0;
  while (index < code.length) {
    const char = code[index]!;
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth <= 0) break;
    } else if (depth === 1 && isWordAt(code, index, 'default')) {
      sawDefault = true;
      break;
    } else if (depth === 1 && isWordAt(code, index, 'case')) {
      const arm = readSwiftCaseArm(code, index);
      arms.push(...arm.names);
      index = arm.end;
      continue;
    }
    index += 1;
  }
  return { arms, sawDefault };
}

/** Offset just past the opening keyword of `inlineResponse(for:)`'s switch, or a failing assert. */
function swiftInlineSwitchStart(code: string): number {
  const declaration = code.indexOf('func inlineResponse(for command: Command)');
  assert.notEqual(declaration, -1, 'RunnerTests+Transport.swift must keep inlineResponse(for:)');
  const switchKeyword = code.indexOf('switch command.command {', declaration);
  assert.notEqual(
    switchKeyword,
    -1,
    'inlineResponse(for:) must keep a switch over command.command for its arms to read',
  );
  return switchKeyword + 'switch command.command'.length;
}

/** The `.name` pattern bindings of one `case` header and the offset of its colon. */
function readSwiftCaseArm(code: string, index: number): { names: string[]; end: number } {
  const headerEnd = code.indexOf(':', index + 'case'.length);
  assert.notEqual(headerEnd, -1, 'a case arm in inlineResponse(for:) must end with a colon');
  const header = code.slice(index + 'case'.length, headerEnd);
  return {
    names: [...header.matchAll(/\.(\w+)/g)].map(([, name]) => name as string),
    end: headerEnd,
  };
}

/** Whether `word` starts at `index`, bounded by non-word characters on both sides. */
function isWordAt(code: string, index: number, word: string): boolean {
  if (!code.startsWith(word, index)) return false;
  const before = index === 0 ? ' ' : code[index - 1]!;
  const after = code[index + word.length] ?? ' ';
  return !/\w/.test(before) && !/\w/.test(after);
}

/**
 * A copy of Swift source with every string and comment replaced by spaces (newlines kept, so offsets
 * and line structure survive). Handles line comments, nested block comments, multiline strings, and
 * string interpolation — the forms that can hide or fake a brace, a `case`, or a `default:`.
 */
export function blankSwiftStringsAndComments(source: string): string {
  const blanker = new SwiftBlanker(source);
  blanker.run();
  return blanker.text();
}

/**
 * Copies Swift source forward with strings and comments replaced by spaces, tracking one cursor so each
 * form (`//`, nested `/* … *\/`, `"…"`, `"""…"""`, and `\\(…)` inside them) is one small scanner.
 */
class SwiftBlanker {
  private readonly out: string[] = [];
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  text(): string {
    return this.out.join('');
  }

  run(): void {
    while (this.index < this.source.length) {
      if (!this.skipTrivia()) {
        this.out.push(this.source[this.index]!);
        this.index += 1;
      }
    }
  }

  /** Blanks one comment or string at the cursor, or reports that the cursor opens neither. */
  private skipTrivia(): boolean {
    if (this.source.startsWith('//', this.index)) {
      const newline = this.source.indexOf('\n', this.index);
      this.blank(newline === -1 ? this.source.length - this.index : newline - this.index);
    } else if (this.source.startsWith('/*', this.index)) {
      this.blank(2);
      this.blankBlockComment();
    } else if (this.source.startsWith(TRIPLE_QUOTE, this.index)) {
      this.blank(3);
      this.blankStringBody(TRIPLE_QUOTE);
    } else if (this.source[this.index] === '"') {
      this.blank(1);
      this.blankStringBody('"');
    } else {
      return false;
    }
    return true;
  }

  /** Blanks the body of an already-opened block comment, honoring Swift's nesting. */
  private blankBlockComment(): void {
    let nesting = 1;
    while (this.index < this.source.length && nesting > 0) {
      if (this.source.startsWith('/*', this.index)) {
        nesting += 1;
        this.blank(2);
      } else if (this.source.startsWith('*/', this.index)) {
        nesting -= 1;
        this.blank(2);
      } else {
        this.blank(1);
      }
    }
  }

  /** Blanks one string body, up to and including `terminator`, honoring escapes and interpolation. */
  private blankStringBody(terminator: string): void {
    while (this.index < this.source.length) {
      if (this.source.startsWith(terminator, this.index)) {
        this.blank(terminator.length);
        return;
      }
      if (this.source.startsWith(ESCAPED_INTERPOLATION, this.index)) {
        this.blankInterpolation();
      } else if (this.source[this.index] === '\\') {
        this.blank(2);
      } else {
        this.blank(1);
      }
    }
  }

  /** Blanks a `\\(…)` interpolation, including its nested parentheses. */
  private blankInterpolation(): void {
    this.blank(2);
    let parens = 1;
    while (this.index < this.source.length && parens > 0) {
      if (this.source[this.index] === '(') parens += 1;
      if (this.source[this.index] === ')') parens -= 1;
      this.blank(1);
    }
  }

  /** Copies `count` characters forward as blanks, keeping newlines so offsets survive. */
  private blank(count: number): void {
    for (let step = 0; step < count && this.index < this.source.length; step += 1) {
      this.out.push(this.source[this.index] === '\n' ? '\n' : ' ');
      this.index += 1;
    }
  }
}

/** The two characters opening a Swift string interpolation. */
const ESCAPED_INTERPOLATION = String.raw`\(`;
const TRIPLE_QUOTE = '"""';

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

/**
 * One row of the settlement table the daemon must honor for a journal state.
 */
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
