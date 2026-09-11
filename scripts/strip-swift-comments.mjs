// Comment removal for the Swift that the npm package ships as source (#2461). `apple/runner/**`
// is copied into `dist/` as-is apart from its unit-test `#if` blocks, so every doc comment and
// every design note is downloaded on every install — 74 kB of the 446 kB measured on v0.21.1.
//
// This is a lexical scanner, not a regex pass, because `//` and `/*` open a comment only in code
// position. String literals may contain either; a raw literal (`#"…"#`) moves its own closing
// delimiter and its interpolation opener with the `#` count, so what counts as an escape changes
// per literal; interpolation segments hold code, including further literals; extended regex
// literals (`#/…/#`) are a second delimiter family that also starts with a `#` run; and Swift
// block comments nest. A regex sees none of that, and the failure mode is a package that does not
// compile on a user's machine. Anything the scanner cannot account for therefore throws here, at
// packaging time, rather than shipping.
//
// Removal never moves a line. `dist/apple/runner/**` is the source an `xcodebuild` or runner
// failure names a file and line in, and those line numbers are only worth reading if they land on
// the same line of `apple/runner/**`, so a comment-only line is emitted empty instead of deleted.
// The blank lines cost ~1 byte each against a ~72 kB saving.
//
// Bare `/…/` regex literals are the one construct no scanner can resolve: the same `/` opens a
// comment, divides, and starts a regex literal, and which it is depends on the parse. Where one
// could start, packaging fails instead of rewriting bytes the scanner cannot prove are code.

/** A `"`/`"""` literal opener with its optional raw `#` delimiters. */
const STRING_OPENER = /(#*)("""|")/y;
/** An extended regex literal opener: a `#` run, then `/`. The `#` count sets the terminator. */
const EXTENDED_REGEX_OPENER = /(#+)\//y;
/** How much emitted output `isExpressionPosition` may look back over. */
const CODE_TAIL_LENGTH = 128;
/**
 * Swift bars a bare regex literal from opening on one of these, so a `/` in front of one — `a / b`,
 * `reduce(/)` — is an operator whatever the parse says.
 */
const NON_REGEX_START = new Set([' ', '\t', '\n', ')']);
/** A `/` directly after one of these ends an operand, so it divides rather than opening a regex. */
const OPERAND_END = /[A-Za-z0-9_$)\]`"?!]$/;
/** The identifier a lookbehind ends on, when it ends on one. */
const TRAILING_IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Keywords a `/` can follow while still being at the start of an expression. Value keywords
 * (`self`, `super`, `nil`, `true`, `false`) are operands and so are deliberately absent.
 */
const EXPRESSION_KEYWORDS = new Set([
  'as',
  'await',
  'borrowing',
  'case',
  'catch',
  'consume',
  'consuming',
  'copy',
  'default',
  'defer',
  'do',
  'each',
  'else',
  'for',
  'guard',
  'if',
  'in',
  'is',
  'let',
  'repeat',
  'return',
  'switch',
  'throw',
  'try',
  'var',
  'where',
  'while',
  'yield',
]);
/** How an unterminated frame is named in the error that refuses to ship the file. */
const FRAME_DESCRIPTIONS = {
  literal: 'string literal',
  regex: 'regex literal',
  interpolation: 'interpolation',
};

/**
 * `source` with its comments removed and its line numbering intact. A line whose only content
 * was a comment is emitted empty rather than dropped, and a comment taken off the end of a code
 * line takes no newline with it, so output line N is input line N for every N. Pre-existing blank
 * lines, and every byte inside a literal, survive untouched.
 *
 * @param {string} source Swift source text.
 * @param {string} filePath Reported in errors, so an unreadable construct names its file.
 * @returns {{ contents: string, removedComments: number }}
 */
export function stripSwiftComments(source, filePath = '<swift source>') {
  const state = {
    source,
    filePath,
    index: 0,
    sourceLine: 1,
    /** Completed output lines, each still carrying its newline. */
    lines: [],
    /** The output line being built. */
    line: '',
    /** The tail of everything emitted so far, for the scanner's one lookbehind. */
    codeTail: '',
    lineHasComment: false,
    /** Literal, regex-literal and interpolation nesting, innermost last. */
    frames: [],
    removedComments: 0,
  };

  while (state.index < source.length) {
    const frame = state.frames.at(-1);
    if (frame?.kind === 'literal') scanStringLiteralCharacter(state, frame);
    else if (frame?.kind === 'regex') scanRegexLiteralCharacter(state, frame);
    else scanCodeCharacter(state);
  }
  finishFile(state);

  return { contents: state.lines.join(''), removedComments: state.removedComments };
}

/** The literal whose bytes are being copied through verbatim, if the scanner is inside one. */
function currentLiteral(state) {
  const frame = state.frames.at(-1);
  return frame !== undefined && (frame.kind === 'literal' || frame.kind === 'regex')
    ? frame
    : undefined;
}

/** Appends to the output line, keeping the lookbehind tail in step with it. */
function emit(state, text) {
  state.line += text;
  state.codeTail = (state.codeTail + text).slice(-CODE_TAIL_LENGTH);
}

function scanCodeCharacter(state) {
  const char = state.source[state.index];
  if (char === '/' && consumeSlash(state)) {
    return;
  }
  if (char === '\n') {
    state.index += 1;
    endLine(state);
    return;
  }
  if ((char === '"' || char === '#') && pushLiteral(state)) {
    return;
  }
  trackInterpolationParenthesis(state, char);
  emit(state, char);
  state.index += 1;
}

/**
 * Resolves the `/` at the cursor: it opens a comment, or it is an operator, or — where the scanner
 * cannot prove which — it fails the file. `false` leaves the `/` to be emitted as an operator.
 */
function consumeSlash(state) {
  const next = state.source[state.index + 1];
  if (next === '/') {
    consumeLineComment(state);
    return true;
  }
  if (next === '*') {
    consumeBlockComment(state);
    return true;
  }
  rejectAmbiguousBareRegexLiteral(state, next);
  return false;
}

/**
 * Opens a literal frame when the `"`/`#` at the cursor really starts one. `#` also leads every
 * Swift directive (`#if`, `#available`, `#!` in the recording scripts), so only a `#`-run followed
 * by a quote is a raw string literal, and only a `#`-run followed by `/` is an extended regex
 * literal.
 */
function pushLiteral(state) {
  return pushStringLiteral(state) || pushExtendedRegexLiteral(state);
}

function pushStringLiteral(state) {
  STRING_OPENER.lastIndex = state.index;
  const opener = STRING_OPENER.exec(state.source);
  if (opener === null) return false;

  const pounds = '#'.repeat(opener[1].length);
  state.frames.push({
    kind: 'literal',
    multiline: opener[2] === '"""',
    terminator: `${opener[2]}${pounds}`,
    escape: `\\${pounds}`,
    startLine: state.sourceLine,
  });
  emit(state, opener[0]);
  state.index += opener[0].length;
  return true;
}

/**
 * Opens an extended regex literal (`#/…/#`, `##/…/##`). Its contents are regex syntax, where `//`
 * and `/*` are ordinary characters, so the frame exists only to keep the comment scanner out. A
 * newline straight after the opener selects Swift's multi-line form, whose closing delimiter has
 * to stand on its own line — everywhere else `/` plus the `#` run is regex content.
 */
function pushExtendedRegexLiteral(state) {
  EXTENDED_REGEX_OPENER.lastIndex = state.index;
  const opener = EXTENDED_REGEX_OPENER.exec(state.source);
  if (opener === null) return false;

  state.frames.push({
    kind: 'regex',
    multiline: state.source[state.index + opener[0].length] === '\n',
    terminator: `/${opener[1]}`,
    startLine: state.sourceLine,
  });
  emit(state, opener[0]);
  state.index += opener[0].length;
  return true;
}

function scanRegexLiteralCharacter(state, regex) {
  if (state.source.startsWith(regex.terminator, state.index)) {
    closeRegexLiteral(state, regex);
    return;
  }
  const char = state.source[state.index];
  // A regex escape is copied as a pair, so `\/` never reads as the closing delimiter.
  if (char === '\\' && isEscapableRegexCharacter(state.source[state.index + 1])) {
    emit(state, state.source.slice(state.index, state.index + 2));
    state.index += 2;
    return;
  }
  if (char === '\n') {
    if (!regex.multiline) {
      throw new Error(`Unterminated regex literal in ${state.filePath}:${regex.startLine}`);
    }
    state.index += 1;
    endLine(state);
    return;
  }
  emit(state, char);
  state.index += 1;
}

/**
 * Closes the literal at its delimiter. Swift closes a multi-line regex literal at the first
 * unescaped `/` plus its `#` run too, but then requires that delimiter to start its own line —
 * so a mid-line one is a file that does not compile either way, and stripping it is refused
 * rather than guessed at.
 */
function closeRegexLiteral(state, regex) {
  if (regex.multiline && state.line.trim() !== '') {
    throw new Error(
      `Multi-line regex literal in ${state.filePath}:${regex.startLine} closes mid-line at ` +
        `line ${state.sourceLine}; its ${regex.terminator} delimiter must start its own line`,
    );
  }
  emit(state, regex.terminator);
  state.index += regex.terminator.length;
  state.frames.pop();
}

function isEscapableRegexCharacter(char) {
  return char !== undefined && char !== '\n';
}

/**
 * Refuses a `/` that could open a bare regex literal. Swift lexes `/…/`, a division and a comment
 * from the same character, and only the parse separates them, so rewriting the bytes after it
 * would be a guess: `let p = /foo//bar/` has no comment in it at all. Packaging fails instead.
 */
function rejectAmbiguousBareRegexLiteral(state, next) {
  if (next === undefined || NON_REGEX_START.has(next)) return;
  if (!isExpressionPosition(state)) return;
  throw new Error(
    `Ambiguous bare regex literal or division in ${state.filePath}:${state.sourceLine}; ` +
      'write the pattern as an extended regex literal (#/…/#), or space the operator (a / b), ' +
      'so packaging can tell them apart',
  );
}

/**
 * Whether an expression could start at the cursor, which is where — and only where — Swift reads
 * a `/` as a bare regex literal. Anywhere else the `/` follows an operand and divides it.
 */
function isExpressionPosition(state) {
  const tail = state.codeTail.replace(/\s+$/u, '');
  if (tail === '') return true;
  if (!OPERAND_END.test(tail)) return true;
  // `return /x/` ends on an identifier yet still starts an expression.
  const identifier = TRAILING_IDENTIFIER.exec(tail)?.[0];
  return identifier !== undefined && EXPRESSION_KEYWORDS.has(identifier);
}

/** Closes an interpolation segment at its matching `)`, so its own parentheses do not end it. */
function trackInterpolationParenthesis(state, char) {
  const frame = state.frames.at(-1);
  if (frame === undefined || frame.kind !== 'interpolation') return;
  if (char === '(') frame.depth += 1;
  if (char !== ')') return;
  frame.depth -= 1;
  if (frame.depth === 0) state.frames.pop();
}

function scanStringLiteralCharacter(state, literal) {
  if (state.source.startsWith(literal.terminator, state.index)) {
    emit(state, literal.terminator);
    state.index += literal.terminator.length;
    state.frames.pop();
    return;
  }
  if (state.source.startsWith(literal.escape, state.index) && consumeEscape(state, literal)) {
    return;
  }
  const char = state.source[state.index];
  if (char === '\n') {
    consumeLiteralNewline(state, literal);
    return;
  }
  emit(state, char);
  state.index += 1;
}

/**
 * Consumes one escape sequence and, for `\(`, enters its interpolation. Copying the escaped
 * character verbatim is what keeps `\"` and `\\` from being read as a delimiter.
 */
function consumeEscape(state, literal) {
  const escapedIndex = state.index + literal.escape.length;
  const char = state.source[escapedIndex];
  if (char === undefined) return false;

  if (char === '\n') {
    // A multiline literal's line continuation: the newline belongs to the literal, but the
    // output still breaks its line here so line accounting stays on the source.
    emit(state, literal.escape);
    state.index = escapedIndex + 1;
    endLine(state);
    return true;
  }

  emit(state, state.source.slice(state.index, escapedIndex + 1));
  state.index = escapedIndex + 1;
  if (char === '(') state.frames.push({ kind: 'interpolation', depth: 1 });
  return true;
}

function consumeLiteralNewline(state, literal) {
  if (!literal.multiline) {
    throw new Error(`Unterminated string literal in ${state.filePath}:${literal.startLine}`);
  }
  state.index += 1;
  endLine(state);
}

function consumeLineComment(state) {
  while (state.index < state.source.length && state.source[state.index] !== '\n') {
    state.index += 1;
  }
  state.lineHasComment = true;
  state.removedComments += 1;
}

function consumeBlockComment(state) {
  const startLine = state.sourceLine;
  state.index += 2;
  let depth = 1;
  while (depth > 0) {
    if (state.index >= state.source.length) {
      throw new Error(`Unterminated block comment in ${state.filePath}:${startLine}`);
    }
    depth += consumeBlockCommentCharacter(state);
  }
  state.lineHasComment = true;
  // One space in place of the comment keeps the tokens that flanked it apart: Swift reads
  // `a/*x*/b` as `a b`, not as `ab`.
  emit(state, ' ');
  state.removedComments += 1;
}

/** The nesting delta for one character of a block comment. */
function consumeBlockCommentCharacter(state) {
  const char = state.source[state.index];
  const next = state.source[state.index + 1];
  if (char === '/' && next === '*') {
    state.index += 2;
    return 1;
  }
  if (char === '*' && next === '/') {
    state.index += 2;
    return -1;
  }
  state.index += 1;
  if (char === '\n') {
    // Both the line being closed and the line being opened are inside the comment, and
    // `endLine` clears the flag between them.
    state.lineHasComment = true;
    endLine(state);
    state.lineHasComment = true;
  }
  return 0;
}

/** Commits the line whose newline was just consumed, blank line and all. */
function endLine(state) {
  state.sourceLine += 1;
  state.lines.push(`${commitLine(state)}\n`);
  state.line = '';
  state.codeTail = (state.codeTail + '\n').slice(-CODE_TAIL_LENGTH);
  state.lineHasComment = false;
}

/**
 * The text one output line carries. A line inside a literal is committed verbatim: its trailing
 * spaces and its emptiness are string content, not layout. A line a comment came off loses the
 * whitespace the comment left behind — and nothing else, so a line that was only a comment
 * commits as empty rather than disappearing.
 */
function commitLine(state) {
  if (currentLiteral(state) !== undefined || !state.lineHasComment) return state.line;
  return state.line.trimEnd();
}

/** The trailing line of a source that does not end in a newline, plus the balance check. */
function finishFile(state) {
  const unterminated = state.frames.at(-1);
  if (unterminated !== undefined) {
    throw new Error(
      `Unterminated ${FRAME_DESCRIPTIONS[unterminated.kind]} in ${state.filePath} ` +
        `(started at line ${unterminated.startLine ?? state.sourceLine})`,
    );
  }
  state.lines.push(commitLine(state));
}
