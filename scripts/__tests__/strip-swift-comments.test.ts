import assert from 'node:assert/strict';
import { test } from 'vitest';
import { stripSwiftComments } from '../strip-swift-comments.mjs';

function strip(source: string, filePath = 'Fixture.swift'): string {
  return stripSwiftComments(source, filePath).contents;
}

function swift(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

test('drops comment-only lines and trailing comments, keeping blank lines', () => {
  const source = swift(
    '// header note',
    '/// doc comment',
    '',
    'let answer = 42  // why',
    '',
    '  // indented note',
    'let next = answer',
  );

  assert.equal(strip(source), swift('', 'let answer = 42', '', 'let next = answer'));
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
  assert.equal(result.contents, swift('let after = 1'));
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
