import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMMAND_VALIDATOR = join(ROOT, 'scripts', 'help-conformance-command-validator.ts');
const ALLOWED_PNPM_SCRIPTS = new Set(['build', 'build:android', 'build:xcuitest', 'clean:daemon']);

export async function validatePlanCommands(commands, options = {}) {
  const parsedCommands = commands.flatMap((command) => parseCommandLine(command));
  const agentCommands = parsedCommands.filter(
    ({ tokens, issues }) => issues.length === 0 && tokens[0] === 'agent-device',
  );
  const agentResults = await validateAgentCommands(
    agentCommands.map(({ tokens }) => tokens.slice(1)),
  );
  const agentResultState = { results: agentResults, index: 0 };
  const allowedExternalCommands = options.allowedExternalCommands ?? [];
  return parsedCommands.map((parsed) =>
    applyCommandPolicy(parsed, agentResultState, allowedExternalCommands),
  );
}

function applyCommandPolicy(parsed, agentResultState, allowedExternalCommands) {
  if (parsed.issues.length > 0) return parsed;
  if (parsed.tokens[0] !== 'agent-device') {
    return validateExternalCommand(parsed, allowedExternalCommands);
  }
  const result = agentResultState.results[agentResultState.index++];
  return result?.valid
    ? parsed
    : withIssue(
        parsed,
        result?.kind ?? 'agent-device-grammar',
        result?.error ?? 'Command validation returned no result.',
      );
}

// The compact workflow card teaches chaining confident consecutive steps with
// an unquoted `&&` (`press ... --settle && fill ... --settle`). Split on it
// before tokenizing a line so each chained segment is validated as its own
// full agent-device invocation, rather than the whole line failing as one
// shell-projection violation. A `&&` inside a quoted selector value (for
// example label="A && B") is not a chain boundary and must not split.
//
// A real shell rejects `&&` with an empty operand on either side (leading
// `&& foo`, trailing `foo &&`, or doubled `foo && && bar`): each is a syntax
// error, not two commands. The splitter below produces an empty segment for
// exactly those shapes, so parseChainSegment turns an empty (post-trim)
// segment into a validation issue instead of silently dropping it — a plan
// with one of these shapes must not be blessed by validPlanCommands when it
// would fail at execution.
function parseCommandLine(command) {
  return splitOnUnquotedAnd(command).map((segment) => parseChainSegment(segment));
}

function parseChainSegment(segment) {
  if (segment.trim().length > 0) return parsePlanCommand(segment.trim());
  return {
    command: segment,
    tokens: [],
    issues: [
      {
        kind: 'empty-chain-operand',
        error:
          'A && chain must have a non-empty command on both sides (no leading, trailing, or doubled &&).',
      },
    ],
  };
}

function splitOnUnquotedAnd(command) {
  const state = { segments: [], current: '', quote: undefined };
  for (let index = 0; index < command.length; index += 1) {
    index = consumeSplitCharacter(command, index, state);
  }
  state.segments.push(state.current);
  return state.segments;
}

function consumeSplitCharacter(command, index, state) {
  const character = command[index];
  if (state.quote) return consumeQuotedSplitCharacter(command, index, character, state);
  if (character === "'" || character === '"') {
    state.quote = character;
    state.current += character;
    return index;
  }
  if (character === '&' && command[index + 1] === '&') {
    state.segments.push(state.current);
    state.current = '';
    return index + 1;
  }
  state.current += character;
  return index;
}

function consumeQuotedSplitCharacter(command, index, character, state) {
  if (character === '\\' && state.quote === '"' && index + 1 < command.length) {
    state.current += character + command[index + 1];
    return index + 1;
  }
  state.current += character;
  if (character === state.quote) state.quote = undefined;
  return index;
}

function parsePlanCommand(command) {
  const tokenized = tokenize(command);
  const issues = [];
  if (/@<[^>]+>/.test(command)) {
    issues.push({
      kind: 'pseudo-ref',
      error: 'Placeholder refs such as @<ref> are not runnable observed refs.',
    });
  }
  if (tokenized.issue) issues.push(tokenized.issue);
  return { command, tokens: tokenized.tokens, issues };
}

function tokenize(command) {
  const state = { tokens: [], current: '', quote: undefined, started: false };
  for (let index = 0; index < command.length; index += 1) {
    const consumed = consumeCharacter(command, index, state);
    if (consumed.issue) return { tokens: state.tokens, issue: consumed.issue };
    index = consumed.nextIndex;
  }
  return finalizeTokens(state);
}

function consumeCharacter(command, index, state) {
  const character = command[index];
  if (state.quote) return consumeQuotedCharacter(command, index, character, state);
  return consumeUnquotedCharacter(command, index, character, state);
}

function consumeUnquotedCharacter(command, index, character, state) {
  const boundary = consumeUnquotedBoundary(character, index, state);
  if (boundary) return boundary;
  if (character === '#' && !state.started) return { nextIndex: command.length };
  const escape = consumeUnquotedEscape(command, index, character, state);
  if (escape) return escape;
  const operator = shellOperatorAt(command, index);
  if (operator) {
    return shellProjectionIssue(
      index,
      `Unquoted shell operator "${operator}" is not allowed in a command plan.`,
    );
  }
  appendCharacter(state, character);
  return { nextIndex: index };
}

function consumeUnquotedBoundary(character, index, state) {
  if (character === "'" || character === '"') {
    state.quote = character;
    state.started = true;
    return { nextIndex: index };
  }
  if (character === '\r' || character === '\n') {
    return shellProjectionIssue(index, 'Unquoted line breaks are not allowed in a command plan.');
  }
  if (/\s/.test(character)) {
    flushToken(state);
    return { nextIndex: index };
  }
  return undefined;
}

function consumeUnquotedEscape(command, index, character, state) {
  if (character !== '\\' || index + 1 >= command.length) return undefined;
  const escaped = command[index + 1];
  if (escaped === '\r' || escaped === '\n') {
    return shellProjectionIssue(index, 'Unquoted line breaks are not allowed in a command plan.');
  }
  appendCharacter(state, escaped);
  return { nextIndex: index + 1 };
}

function shellProjectionIssue(nextIndex, error) {
  return {
    nextIndex,
    issue: {
      kind: 'shell-projection',
      error,
    },
  };
}

function consumeQuotedCharacter(command, index, character, state) {
  if (character === state.quote) {
    state.quote = undefined;
    state.started = true;
    return { nextIndex: index };
  }
  if (character === '\\' && state.quote === '"' && index + 1 < command.length) {
    appendCharacter(state, command[index + 1]);
    return { nextIndex: index + 1 };
  }
  appendCharacter(state, character);
  return { nextIndex: index };
}

function appendCharacter(state, character) {
  state.current += character;
  state.started = true;
}

function flushToken(state) {
  if (!state.started) return;
  state.tokens.push(state.current);
  state.current = '';
  state.started = false;
}

function finalizeTokens(state) {
  if (state.quote) {
    return {
      tokens: state.tokens,
      issue: { kind: 'shell-projection', error: `Unclosed ${state.quote} quote.` },
    };
  }
  flushToken(state);
  return state.tokens.length > 0
    ? { tokens: state.tokens }
    : {
        tokens: state.tokens,
        issue: { kind: 'command-shape', error: 'Command line is empty.' },
      };
}

function shellOperatorAt(command, index) {
  const character = command[index];
  if (character === '`' || '|;<>'.includes(character)) return character;
  if (character === '&') return command[index + 1] === '&' ? '&&' : '&';
  if (character === '$' && command[index + 1] === '(') return '$(';
  return undefined;
}

function validateExternalCommand(parsed, allowedExternalCommands) {
  const executable = parsed.tokens[0];
  if (!allowedExternalCommands.includes(executable)) {
    return withIssue(
      parsed,
      'executable-policy',
      `Executable "${executable}" is not permitted for this case.`,
    );
  }
  if (executable === 'mkdir') {
    return parsed.tokens.length >= 3 && parsed.tokens[1] === '-p'
      ? parsed
      : withIssue(parsed, 'external-command-grammar', 'Only mkdir -p <path> is permitted.');
  }
  if (executable === 'pnpm') {
    return validatePnpmCommand(parsed);
  }
  return withIssue(
    parsed,
    'external-command-grammar',
    `No command grammar is registered for "${executable}".`,
  );
}

function validatePnpmCommand(parsed) {
  const args = parsed.tokens[1] === 'run' ? parsed.tokens.slice(2) : parsed.tokens.slice(1);
  const [script, ...scriptArgs] = args;
  if (!ALLOWED_PNPM_SCRIPTS.has(script)) {
    return withIssue(
      parsed,
      'external-command-grammar',
      `Permitted pnpm scripts: ${[...ALLOWED_PNPM_SCRIPTS].join(', ')}.`,
    );
  }
  const validArgs =
    scriptArgs.length === 0 ||
    (script === 'clean:daemon' && scriptArgs.length === 1 && scriptArgs[0] === '--prune-dev');
  return validArgs
    ? parsed
    : withIssue(parsed, 'external-command-grammar', `Unsupported arguments for pnpm ${script}.`);
}

async function validateAgentCommands(argvs) {
  if (argvs.length === 0) return [];
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', COMMAND_VALIDATOR, JSON.stringify(argvs)],
    { maxBuffer: 1024 * 1024, timeout: 10_000 },
  );
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('Command validator returned a non-array result.');
  return parsed;
}

function withIssue(parsed, kind, error) {
  return { ...parsed, issues: [...parsed.issues, { kind, error }] };
}
