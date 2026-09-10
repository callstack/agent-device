// Comment removal for the Swift that the npm package ships as source (#2461). `apple/runner/**`
// is copied into `dist/` as-is apart from its unit-test `#if` blocks, so every doc comment and
// every design note is downloaded on every install — 74 kB of the 446 kB measured on v0.21.1.
//
// This is a lexical scanner, not a regex pass, because `//` and `/*` open a comment only in code
// position. String literals may contain either; a raw literal (`#"…"#`) moves its own closing
// delimiter and its interpolation opener with the `#` count, so what counts as an escape changes
// per literal; interpolation segments hold code, including further literals; and Swift block
// comments nest. A regex sees none of that, and the failure mode is a package that does not
// compile on a user's machine. Anything the scanner cannot account for therefore throws here, at
// packaging time, rather than shipping.

/** A `"`/`"""` literal opener with its optional raw `#` delimiters. */
const STRING_OPENER = /(#*)("""|")/y;

/**
 * `source` with its comments removed. A line whose only content was a comment disappears;
 * pre-existing blank lines, and every byte inside a literal, survive untouched.
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
    lineHasComment: false,
    /** Literal and interpolation nesting, innermost last. */
    frames: [],
    removedComments: 0,
  };

  while (state.index < source.length) {
    const literal = currentStringLiteral(state);
    if (literal === undefined) scanCodeCharacter(state);
    else scanStringLiteralCharacter(state, literal);
  }
  finishFile(state);

  return { contents: state.lines.join(''), removedComments: state.removedComments };
}

function currentStringLiteral(state) {
  const frame = state.frames.at(-1);
  return frame !== undefined && frame.kind === 'literal' ? frame : undefined;
}

function scanCodeCharacter(state) {
  const char = state.source[state.index];
  const next = state.source[state.index + 1];
  if (char === '/' && next === '/') {
    consumeLineComment(state);
    return;
  }
  if (char === '/' && next === '*') {
    consumeBlockComment(state);
    return;
  }
  if (char === '\n') {
    state.index += 1;
    endLine(state);
    return;
  }
  if ((char === '"' || char === '#') && pushStringLiteral(state)) {
    return;
  }
  trackInterpolationParenthesis(state, char);
  state.line += char;
  state.index += 1;
}

/**
 * Opens a literal frame when the `"`/`#` at the cursor really starts one. `#` also leads every
 * Swift directive (`#if`, `#available`, `#!` in the recording scripts), so only a `#`-run
 * followed by a quote is a raw literal.
 */
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
  state.line += opener[0];
  state.index += opener[0].length;
  return true;
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
    state.line += literal.terminator;
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
  state.line += char;
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
    state.line += literal.escape;
    state.index = escapedIndex + 1;
    endLine(state);
    return true;
  }

  state.line += state.source.slice(state.index, escapedIndex + 1);
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
  state.line += ' ';
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

/**
 * Commits the line whose newline was just consumed. A line inside a literal is committed
 * verbatim: its trailing spaces and its emptiness are string content, not layout.
 */
function endLine(state) {
  state.sourceLine += 1;
  if (currentStringLiteral(state) !== undefined || !state.lineHasComment) {
    state.lines.push(`${state.line}\n`);
  } else if (state.line.trim() !== '') {
    state.lines.push(`${state.line.trimEnd()}\n`);
  }
  state.line = '';
  state.lineHasComment = false;
}

/** The trailing line of a source that does not end in a newline, plus the balance check. */
function finishFile(state) {
  const unterminated = state.frames.at(-1);
  if (unterminated !== undefined) {
    throw new Error(
      `Unterminated ${unterminated.kind} in ${state.filePath} ` +
        `(started at line ${unterminated.startLine ?? state.sourceLine})`,
    );
  }
  if (state.line === '') return;
  if (state.lineHasComment) {
    if (state.line.trim() !== '') state.lines.push(state.line.trimEnd());
    return;
  }
  state.lines.push(state.line);
}
