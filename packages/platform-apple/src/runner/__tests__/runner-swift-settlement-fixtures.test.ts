import { describe, expect, test } from 'vitest';
import {
  blankSwiftStringsAndComments,
  parseSwiftInlineCommandArms,
} from './runner-swift-settlement-fixtures.ts';

// The arm reader decides which commands the daemon is allowed to treat as inline, so every failure
// mode here shrinks that set and stays green — the drift the tie exists to catch (#2965). These
// shapes are the ones the line-based reader it replaced got wrong.

const SWITCH = `func inlineResponse(for command: Command) -> Response? {
  switch command.command {
$ARMS$
  default:
    return nil
  }
}
`;

function sourceWith(arms: string): string {
  return SWITCH.replace('$ARMS$', arms);
}

describe('parseSwiftInlineCommandArms', () => {
  test('reads plain arms and stops at default:', () => {
    const { arms, sawDefault } = parseSwiftInlineCommandArms(
      sourceWith(`    case .status:
      return executeStatus(command: command)
    case .uptime:
      return executeUptime()`),
    );

    expect(arms).toEqual(['status', 'uptime']);
    expect(sawDefault).toBe(true);
  });

  test('reads a combined arm on one line', () => {
    expect(parseSwiftInlineCommandArms(sourceWith('    case .status, .uptime:')).arms).toEqual([
      'status',
      'uptime',
    ]);
  });

  test('reads a combined arm wrapped across lines', () => {
    expect(
      parseSwiftInlineCommandArms(sourceWith('    case .status,\n      .uptime:')).arms,
    ).toEqual(['status', 'uptime']);
  });

  test('reads a body that opens its brace on the header line', () => {
    const { arms } = parseSwiftInlineCommandArms(
      sourceWith(`    case .status: {
        let response = executeStatus(command: command)
        return response
      }`),
    );

    expect(arms).toEqual(['status']);
  });

  test('ignores a default: nested inside an arm body', () => {
    const { arms, sawDefault } = parseSwiftInlineCommandArms(
      sourceWith(`    case .status:
      switch command.kind {
      default:
        break
      }
    case .uptime:
      return executeUptime()`),
    );

    expect(arms).toEqual(['status', 'uptime']);
    expect(sawDefault).toBe(true);
  });

  test('ignores braces inside a multiline string body', () => {
    const { arms } = parseSwiftInlineCommandArms(
      sourceWith(`    case .status:
      let json = """
      {
        "ok": true
      }
      """
      return Response(json)
    case .uptime:
      return executeUptime()`),
    );

    expect(arms).toEqual(['status', 'uptime']);
  });

  test('ignores a case keyword hidden in a comment', () => {
    const { arms } = parseSwiftInlineCommandArms(
      sourceWith(`    case .status:
      // case .appState: this comment must not name a command
    case .uptime:
      return executeUptime()`),
    );

    expect(arms).toEqual(['status', 'uptime']);
  });

  test('ignores a command name hidden in a string', () => {
    const { arms } = parseSwiftInlineCommandArms(
      sourceWith(`    case .status:
      return error("case .appState is not inline")
    case .uptime:
      return executeUptime()`),
    );

    expect(arms).toEqual(['status', 'uptime']);
  });

  test('reports no default when the switch never reaches one', () => {
    const { arms, sawDefault } = parseSwiftInlineCommandArms(
      `func inlineResponse(for command: Command) -> Response? {
  switch command.command {
  case .status:
    return nil
  }
}`,
    );

    expect(arms).toEqual(['status']);
    expect(sawDefault).toBe(false);
  });

  test('ignores a switch in a different function', () => {
    const { arms } = parseSwiftInlineCommandArms(`
func unrelated(command: Command) -> Int {
  switch command.command {
  case .bogus:
    return 1
  default:
    return 0
  }
}
${sourceWith('    case .status:\n      return nil')}`);

    expect(arms).toEqual(['status']);
  });
});

describe('blankSwiftStringsAndComments', () => {
  test('keeps length and newlines so offsets survive', () => {
    const source = 'let a = "// not code"\nlet b = /* block */ 2\n';
    const blanked = blankSwiftStringsAndComments(source);

    expect(blanked).toHaveLength(source.length);
    expect((blanked.match(/\n/g) ?? []).length).toBe(2);
  });

  test('blanks a nested block comment, marker pair included', () => {
    const blanked = blankSwiftStringsAndComments('code /* a /* b */ c */ more');
    const middle = blanked.slice('code '.length, blanked.length - ' more'.length);

    expect(blanked.startsWith('code ')).toBe(true);
    expect(blanked.endsWith(' more')).toBe(true);
    expect(middle).toBe(' '.repeat(middle.length));
  });

  test('blanks interpolation, braces and all, and leaves real braces alone', () => {
    const blanked = blankSwiftStringsAndComments(
      String.raw`let s = "value { \(nested { ) } tail" { }`,
    );
    const blankedRegion = blanked.slice('let s = '.length, blanked.length - '{ }'.length);

    expect(blanked.startsWith('let s = ')).toBe(true);
    expect(blanked.endsWith('{ }')).toBe(true);
    expect(/[[{("]/.test(blankedRegion)).toBe(false);
  });

  test('blanks a multiline string body and the braces inside it', () => {
    const blanked = blankSwiftStringsAndComments('let m = """\n{\n}\n"""\ncase .x:');

    expect(blanked).toBe('let m =    \n \n \n   \ncase .x:');
  });

  test('leaves code untouched', () => {
    expect(blankSwiftStringsAndComments('case .status: return {}')).toBe('case .status: return {}');
  });
});
