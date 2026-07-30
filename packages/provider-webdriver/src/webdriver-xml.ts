export type WebDriverXmlNode = {
  name: string;
  attributes: Record<string, string>;
  children: WebDriverXmlNode[];
};

const MAX_DOCUMENT_CHARS = 128 * 1024 * 1024;
const MAX_NESTING_DEPTH = 256;
const UNSAFE_ATTRIBUTE_NAMES = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__proto__',
  'constructor',
  'prototype',
]);

export function parseWebDriverXml(source: string): WebDriverXmlNode[] {
  if (source.length > MAX_DOCUMENT_CHARS) {
    throw new Error(
      `XML document exceeds maximum supported size of ${MAX_DOCUMENT_CHARS} characters.`,
    );
  }
  const roots: WebDriverXmlNode[] = [];
  const stack: WebDriverXmlNode[] = [];
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (offset < source.length) {
    const opening = source.indexOf('<', offset);
    if (opening === -1) break;
    offset = opening;
    if (source.startsWith('<!--', offset)) {
      offset = skipDelimited(source, offset, '-->', 'Comment is not closed.');
      continue;
    }
    if (source.startsWith('<?', offset)) {
      offset = skipDelimited(source, offset, '?>', 'Processing instruction is not closed.');
      continue;
    }
    if (source.startsWith('<![CDATA[', offset)) {
      offset = skipDelimited(source, offset, ']]>', 'CDATA section is not closed.');
      continue;
    }
    if (source.startsWith('<!', offset)) {
      offset = declarationEnd(source, offset);
      continue;
    }
    if (source.startsWith('</', offset)) {
      offset = closeNode(source, offset, stack);
      continue;
    }
    const parsed = readOpeningNode(source, offset);
    const parent = stack.at(-1);
    if (parent) parent.children.push(parsed.node);
    else roots.push(parsed.node);
    if (!parsed.selfClosing) {
      if (stack.length >= MAX_NESTING_DEPTH) {
        throw new Error(`Maximum XML nesting depth of ${MAX_NESTING_DEPTH} exceeded.`);
      }
      stack.push(parsed.node);
    }
    offset = parsed.end;
  }

  const unclosed = stack.at(-1);
  if (unclosed) throw new Error(`Unclosed XML tag <${unclosed.name}>.`);
  return roots;
}

function readOpeningNode(
  source: string,
  opening: number,
): { node: WebDriverXmlNode; selfClosing: boolean; end: number } {
  let cursor = opening + 1;
  cursor = skipWhitespace(source, cursor);
  const name = readName(source, cursor);
  if (!name.value) throw new Error(`Missing XML tag name at offset ${cursor}.`);
  cursor = name.end;
  const attributes: Record<string, string> = {};

  while (cursor < source.length) {
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === '>') {
      return {
        node: { name: name.value, attributes, children: [] },
        selfClosing: false,
        end: cursor + 1,
      };
    }
    if (source[cursor] === '/' && source[cursor + 1] === '>') {
      return {
        node: { name: name.value, attributes, children: [] },
        selfClosing: true,
        end: cursor + 2,
      };
    }
    const attribute = readName(source, cursor);
    if (!attribute.value) throw new Error(`Invalid XML attribute at offset ${cursor}.`);
    assertSafeAttributeName(attribute.value);
    cursor = skipWhitespace(source, attribute.end);
    if (source[cursor] !== '=') {
      throw new Error(`Missing value for XML attribute "${attribute.value}".`);
    }
    cursor = skipWhitespace(source, cursor + 1);
    const value = readQuotedValue(source, cursor, attribute.value);
    attributes[attribute.value] = decodeXmlEntities(value.value.trim());
    cursor = value.end;
  }
  throw new Error('Opening XML tag is not closed.');
}

function closeNode(source: string, opening: number, stack: WebDriverXmlNode[]): number {
  let cursor = skipWhitespace(source, opening + 2);
  const name = readName(source, cursor);
  cursor = skipWhitespace(source, name.end);
  if (source[cursor] !== '>') {
    throw new Error(`Closing XML tag </${name.value}> is not closed.`);
  }
  const node = stack.pop();
  if (!node) throw new Error(`Unexpected closing XML tag </${name.value}>.`);
  if (node.name !== name.value) {
    throw new Error(`Expected </${node.name}> before </${name.value}>.`);
  }
  return cursor + 1;
}

function readQuotedValue(
  source: string,
  offset: number,
  attributeName: string,
): { value: string; end: number } {
  const quote = source[offset];
  if (quote !== '"' && quote !== "'") {
    throw new Error(`XML attribute "${attributeName}" must use a quoted value.`);
  }
  const end = source.indexOf(quote, offset + 1);
  if (end === -1) throw new Error(`XML attribute "${attributeName}" is not closed.`);
  return { value: source.slice(offset + 1, end), end: end + 1 };
}

function readName(source: string, offset: number): { value: string; end: number } {
  let end = offset;
  while (end < source.length && /[A-Za-z0-9_.:-]/.test(source[end]!)) end += 1;
  return { value: source.slice(offset, end), end };
}

function skipWhitespace(source: string, offset: number): number {
  let cursor = offset;
  while (cursor < source.length && /\s/.test(source[cursor]!)) cursor += 1;
  return cursor;
}

function skipDelimited(
  source: string,
  offset: number,
  delimiter: string,
  errorMessage: string,
): number {
  const end = source.indexOf(delimiter, offset + delimiter.length);
  if (end === -1) throw new Error(errorMessage);
  return end + delimiter.length;
}

function declarationEnd(source: string, offset: number): number {
  let quote: string | undefined;
  let bracketDepth = 0;
  for (let cursor = offset + 2; cursor < source.length; cursor += 1) {
    const char = source[cursor]!;
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '[') bracketDepth += 1;
    else if (char === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (char === '>' && bracketDepth === 0) return cursor + 1;
  }
  throw new Error('XML declaration is not closed.');
}

function assertSafeAttributeName(name: string): void {
  if (UNSAFE_ATTRIBUTE_NAMES.has(name)) {
    throw new Error(`Unsupported XML attribute name "${name}".`);
  }
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
    (entity, body: string) => {
      switch (body) {
        case 'amp':
          return '&';
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default: {
          const codePoint = body.startsWith('#x')
            ? Number.parseInt(body.slice(2), 16)
            : Number(body.slice(1));
          return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : entity;
        }
      }
    },
  );
}
