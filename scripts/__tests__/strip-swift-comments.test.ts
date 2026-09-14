import assert from 'node:assert/strict';
import { test } from 'vitest';
import { stripSwiftComments } from '../strip-swift-comments.mjs';

function strip(source: string, filePath = 'Fixture.swift'): string {
  return stripSwiftComments(source, filePath).contents;
}

function swift(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

// The packaged file's line N has to be the checkout's line N: `dist/apple/runner/**` is what a
// user's `xcodebuild` and the runner name a file and line in, so a removed comment empties its
// line and never deletes it. scripts/check-packaged-runner-swift.ts asserts the same property
// over all 44 shipped files.
test('empties a comment-only line instead of deleting it, keeping every line number', () => {
  const source = swift(
    '// header note',
    '/// doc comment',
    '',
    'let answer = 42  // why',
    '',
    '  // indented note',
    'let next = answer',
  );

  const stripped = strip(source);
  assert.equal(stripped, swift('', '', '', 'let answer = 42', '', '', 'let next = answer'));
  assert.equal(stripped.split('\n').length, source.split('\n').length);
  // The code lines sit on the lines they sat on in the source: 4 and 7, not 2 and 4.
  assert.equal(stripped.split('\n')[3], 'let answer = 42');
  assert.equal(stripped.split('\n')[6], 'let next = answer');
});

test('keeps line numbering when every line is a comment', () => {
  const source = swift('// one', '   // two', '/* three */', '/// four');

  assert.equal(strip(source), swift('', '', '', ''));
});

test('a file with no comments is returned byte for byte', () => {
  const source = swift('import XCTest', '', 'let trailing = "  spaces  "   ', 'let last = 1');

  assert.equal(strip(source), source);
  assert.equal(stripSwiftComments(source).removedComments, 0);
});

test('leaves // inside string literals alone', () => {
  const source = swift(
    'let url = "https://example.com/path" // real comment',
    'let format = "%@ // %@"',
    String.raw`let escaped = "quote \" then // not a comment"`,
    'let empty = ""  // after an empty literal',
  );

  assert.equal(
    strip(source),
    swift(
      'let url = "https://example.com/path"',
      'let format = "%@ // %@"',
      String.raw`let escaped = "quote \" then // not a comment"`,
      'let empty = ""',
    ),
  );
});

test('leaves /* inside string literals alone', () => {
  const source = swift('let glob = "/* not a comment */"', 'let real = 1 /* is a comment */');

  assert.equal(strip(source), swift('let glob = "/* not a comment */"', 'let real = 1'));
});

test('preserves raw string literals and their comment-shaped contents', () => {
  const source = swift(
    'let json = #"{"href":"https://example.com//x"}"#  // trailing',
    'let pounded = ##"a "# b // c"##',
    String.raw`let literalEscape = #"a \(notInterpolated) // still text"#`,
  );

  assert.equal(
    strip(source),
    swift(
      'let json = #"{"href":"https://example.com//x"}"#',
      'let pounded = ##"a "# b // c"##',
      String.raw`let literalEscape = #"a \(notInterpolated) // still text"#`,
    ),
  );
});

test('preserves multi-line string literals verbatim, blank and comment-shaped lines included', () => {
  const source = swift(
    'let usage = """',
    '  // not a comment',
    '',
    '  /* also not a comment */',
    '  trailing spaces kept   ',
    '  """  // trailing comment on the closing line',
    'let after = 1',
  );

  assert.equal(
    strip(source),
    swift(
      'let usage = """',
      '  // not a comment',
      '',
      '  /* also not a comment */',
      '  trailing spaces kept   ',
      '  """',
      'let after = 1',
    ),
  );
});

test('preserves a multi-line raw literal and its line continuations', () => {
  const source = swift(
    'let raw = #"""',
    String.raw`  keep "# and // and \(this)`,
    '  """#',
    'let plain = """',
    '  joined \\',
    '  lines',
    '  """',
  );

  assert.equal(strip(source), source);
});

// Every Swift snippet in the regex-literal tests below parses clean under `xcrun swiftc -parse`
// (Swift 6.2), and so does what the scanner leaves of it. `#/foo//bar/#` has no comment in it at
// all: before the scanner knew the delimiter, it shipped `let pattern = #/foo`.
test('preserves extended regex literals whose contents are comment-shaped', () => {
  const source = swift(
    'let pattern = #/foo//bar/#',
    'let pounded = ##/a//b/#c/##',
    'let blockish = #/x/*y/#',
    String.raw`let escaped = #/a\/#b/#`,
  );

  assert.equal(strip(source), source);
  assert.equal(stripSwiftComments(source).removedComments, 0);
});

test('strips a real comment that trails an extended regex literal', () => {
  const source = swift(
    'let trailing = #/a//b/#  // trailing',
    'let blocked = ##/c/*d*/##  /* block */',
    'let next = 1',
  );

  assert.equal(
    strip(source),
    swift('let trailing = #/a//b/#', 'let blocked = ##/c/*d*/##', 'let next = 1'),
  );
  assert.equal(stripSwiftComments(source).removedComments, 2);
});

test('preserves a multi-line extended regex literal verbatim, comment-shaped lines included', () => {
  const source = swift(
    'let multi = #/',
    '  foo//bar',
    '  /*e*/',
    String.raw`  a\/#b`,
    '',
    '  /#',
    'let after = 1  // note',
  );

  assert.equal(
    strip(source),
    swift(
      'let multi = #/',
      '  foo//bar',
      '  /*e*/',
      String.raw`  a\/#b`,
      '',
      '  /#',
      'let after = 1',
    ),
  );
});

test('reads an unspaced division as an operator, not as a bare regex literal', () => {
  const source = swift(
    '#!/usr/bin/env swift',
    'let half = width/2  // note',
    'let ratio = Double(3)/Double(4)',
    'let spaced = width / 2  // also fine',
    'let divide: (Int, Int) -> Int = (/)',
  );

  assert.equal(
    strip(source),
    swift(
      '#!/usr/bin/env swift',
      'let half = width/2',
      'let ratio = Double(3)/Double(4)',
      'let spaced = width / 2',
      'let divide: (Int, Int) -> Int = (/)',
    ),
  );
});

test('reads interpolation segments as code without losing their nested literals', () => {
  const source = swift(
    String.raw`let line = "prefix \(makeURL("https://example.com")) suffix" // trailing`,
    String.raw`let nested = "\(count(of: (a, b))) items"`,
    String.raw`let rawInterpolated = #"\#(value) // text"#`,
  );

  assert.equal(
    strip(source),
    swift(
      String.raw`let line = "prefix \(makeURL("https://example.com")) suffix"`,
      String.raw`let nested = "\(count(of: (a, b))) items"`,
      String.raw`let rawInterpolated = #"\#(value) // text"#`,
    ),
  );
});

test('removes nested block comments as one comment', () => {
  const source = swift(
    '/* outer',
    '   /* inner // with a line comment */',
    '   still outer */',
    'let after = 1',
  );

  const result = stripSwiftComments(source);
  assert.equal(result.contents, swift('', '', '', 'let after = 1'));
  assert.equal(result.removedComments, 1);
});

test('keeps flanking tokens apart when a block comment is removed', () => {
  assert.equal(strip('let sum = a/*gap*/+b\n'), 'let sum = a +b\n');
  assert.equal(strip('call(/*label*/value)\n'), 'call( value)\n');
});

test('keeps statements on separate lines when a block comment spans lines', () => {
  const source = swift('let a = 1 /* spans', 'the newline */ let b = 2');

  assert.equal(strip(source), swift('let a = 1', '  let b = 2'));
});

test('preserves conditional compilation directives and strips their trailing comments', () => {
  const source = swift(
    '#if AGENT_DEVICE_RUNNER_UNIT_TESTS  // only in unit-test builds',
    '  #if os(iOS)',
    '  let platform = "ios"',
    '  #else',
    '  // macOS has no equivalent',
    '  let platform = "macos"',
    '  #endif',
    '#endif',
    '#if canImport(UIKit)',
    'import UIKit',
    '#endif',
  );

  assert.equal(
    strip(source),
    swift(
      '#if AGENT_DEVICE_RUNNER_UNIT_TESTS',
      '  #if os(iOS)',
      '  let platform = "ios"',
      '  #else',
      '',
      '  let platform = "macos"',
      '  #endif',
      '#endif',
      '#if canImport(UIKit)',
      'import UIKit',
      '#endif',
    ),
  );
});

test('does not mistake pound directives or a shebang for a raw literal', () => {
  const source = swift(
    '#!/usr/bin/env swift',
    'if #available(iOS 15, *) {',
    '  print(#function)  // note',
    '}',
  );

  assert.equal(
    strip(source),
    swift('#!/usr/bin/env swift', 'if #available(iOS 15, *) {', '  print(#function)', '}'),
  );
});

test('drops a trailing comment on a final line without a newline', () => {
  assert.equal(strip('let a = 1 // note'), 'let a = 1');
  assert.equal(strip('// whole file is a comment'), '');
  assert.equal(strip('let a = 1'), 'let a = 1');
});

test('counts every removed comment', () => {
  const result = stripSwiftComments(swift('// one', 'let a = 1 // two', 'let b = /* three */ 2'));

  assert.equal(result.removedComments, 3);
});

test('throws on an unterminated block comment rather than shipping the rest of the file', () => {
  assert.throws(
    () => strip(swift('let a = 1', '/* never closed', 'let b = 2')),
    /Unterminated block comment in Fixture\.swift:2/,
  );
});

test('throws on an unterminated string literal rather than guessing where it ends', () => {
  assert.throws(
    () => strip(swift('let a = 1', 'let broken = "no closing quote', 'let b = 2 // note')),
    /Unterminated string literal in Fixture\.swift:2/,
  );
});

test('throws when an interpolation segment never closes', () => {
  assert.throws(
    () => strip(swift(String.raw`let a = "\(value`)),
    /Unterminated interpolation in Fixture\.swift/,
  );
});

// A bare `/…/` is the one construct a scanner cannot resolve: Swift lexes a comment, a division
// and a regex literal from the same `/`, and only the parse tells them apart. Packaging fails
// rather than rewrite bytes it cannot prove are code.
test('throws on a bare regex literal instead of reading its contents as a comment', () => {
  assert.throws(
    () => strip(swift('let a = 1', 'let pattern = /foo//bar/')),
    /Ambiguous bare regex literal or division in Fixture\.swift:2/,
  );
  assert.throws(
    () => strip(swift('func f() -> Regex<Substring> {', String.raw`  return /x\/y/`, '}')),
    /Ambiguous bare regex literal or division in Fixture\.swift:2/,
  );
});

test('throws on an unterminated extended regex literal', () => {
  assert.throws(
    () => strip(swift('let a = 1', 'let pattern = #/no closing', 'let b = 2 // note')),
    /Unterminated regex literal in Fixture\.swift:2/,
  );
  assert.throws(
    () => strip(swift('let a = 1', 'let pattern = #/', '  never closed')),
    /Unterminated regex literal in Fixture\.swift \(started at line 2\)/,
  );
});

test('throws when a multi-line regex literal closes mid-line', () => {
  assert.throws(
    () => strip(swift('let multi = #/', '  mid/#line stays', '  /#')),
    /Multi-line regex literal in Fixture\.swift:1 closes mid-line at line 2/,
  );
});
