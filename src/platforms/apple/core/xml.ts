export type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  text: string | null;
  children: XmlNode[];
};

const MAX_XML_NESTING_DEPTH = 256;
const MAX_XML_DOCUMENT_CHARS = 128 * 1024 * 1024;
const XML_NAME_CHARS = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-',
);
const XML_WHITESPACE_CHARS = new Set([' ', '\t', '\n', '\r']);
const UNSAFE_XML_ATTRIBUTE_NAMES = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__proto__',
  'constructor',
  'prototype',
]);

export function parseXmlDocumentSync(
  xml: string,
  options: { maxDocumentChars?: number } = {},
): XmlNode[] {
  const maxDocumentChars = options.maxDocumentChars ?? MAX_XML_DOCUMENT_CHARS;
  if (xml.length > maxDocumentChars) {
    throw new Error(
      `XML document exceeds maximum supported size of ${maxDocumentChars} characters.`,
    );
  }
  return new LimitedXmlParser(xml).parse();
}

export function visitXmlPlistEntries(
  nodes: XmlNode[],
  visitor: (key: string, valueNode: XmlNode) => void,
): void {
  for (const node of nodes) {
    if (node.name === 'dict') {
      for (let index = 0; index < node.children.length - 1; index += 1) {
        const entry = node.children[index];
        const nextEntry = node.children[index + 1];
        if (entry?.name === 'key' && entry.text && nextEntry) {
          visitor(entry.text, nextEntry);
        }
      }
    }
    visitXmlPlistEntries(node.children, visitor);
  }
}

class LimitedXmlParser {
  private readonly roots: XmlNode[] = [];
  private readonly stack: XmlNode[] = [];
  private index = 0;
  private readonly xml: string;

  constructor(xml: string) {
    this.xml = xml;
  }

  parse(): XmlNode[] {
    this.skipByteOrderMark();
    while (this.index < this.xml.length) {
      this.readNextToken();
    }
    this.assertFullyClosed();
    return this.roots;
  }

  private readNextToken(): void {
    if (this.xml[this.index] !== '<') {
      this.readText();
      return;
    }

    const reader = this.resolveMarkupReader();
    reader();
  }

  private resolveMarkupReader(): () => void {
    if (this.startsWith('<!--')) return () => this.skipUntil('-->', 'Comment is not closed.');
    if (this.startsWith('<?'))
      return () => this.skipUntil('?>', 'Processing instruction is not closed.');
    if (this.startsWith('<![CDATA[')) return () => this.readCdata();
    if (this.startsWith('<!')) return () => this.skipDeclaration();
    if (this.startsWith('</')) return () => this.readClosingTag();
    return () => this.readOpeningTag();
  }

  private assertFullyClosed(): void {
    if (this.stack.length > 0) {
      const node = this.stack[this.stack.length - 1];
      throw new Error(`Unclosed XML tag <${node?.name ?? 'unknown'}>.`);
    }
  }

  private skipByteOrderMark(): void {
    if (this.xml.charCodeAt(0) === 0xfeff) {
      this.index = 1;
    }
  }

  private readOpeningTag(): void {
    this.index += 1;
    this.skipWhitespace();
    const name = this.readRequiredName(`Missing XML tag name at offset ${this.index}.`);
    const { attributes, selfClosing } = this.readOpeningTagBody();

    const node: XmlNode = { name, attributes, text: null, children: [] };
    this.addNode(node);
    if (!selfClosing) {
      this.pushOpenNode(node);
    }
  }

  private readOpeningTagBody(): { attributes: Record<string, string>; selfClosing: boolean } {
    const attributes: Record<string, string> = {};
    while (true) {
      this.skipWhitespace();
      const tagEnd = this.readOpeningTagEnd();
      if (tagEnd) return { attributes, selfClosing: tagEnd === 'self-closing' };
      const attribute = this.readAttribute();
      attributes[attribute.name] = attribute.value;
    }
  }

  private readOpeningTagEnd(): 'open' | 'self-closing' | null {
    if (this.index >= this.xml.length) throw new Error('Opening XML tag is not closed.');
    if (this.xml[this.index] === '>') {
      this.index += 1;
      return 'open';
    }
    if (this.xml[this.index] === '/' && this.xml[this.index + 1] === '>') {
      this.index += 2;
      return 'self-closing';
    }
    return null;
  }

  private readAttribute(): { name: string; value: string } {
    const name = this.readRequiredName(`Invalid XML attribute at offset ${this.index}.`);
    assertSafeXmlAttributeName(name);
    this.skipWhitespace();
    if (this.xml[this.index] !== '=') {
      throw new Error(`Missing value for XML attribute "${name}".`);
    }
    this.index += 1;
    this.skipWhitespace();
    return { name, value: this.readAttributeValue(name) };
  }

  private pushOpenNode(node: XmlNode): void {
    if (this.stack.length >= MAX_XML_NESTING_DEPTH) {
      throw new Error(`Maximum XML nesting depth of ${MAX_XML_NESTING_DEPTH} exceeded.`);
    }
    this.stack.push(node);
  }

  private readClosingTag(): void {
    this.index += 2;
    this.skipWhitespace();
    const name = this.readName();
    this.skipWhitespace();
    if (this.xml[this.index] !== '>') {
      throw new Error(`Closing XML tag </${name}> is not closed.`);
    }
    this.index += 1;

    const node = this.stack.pop();
    if (!node) {
      throw new Error(`Unexpected closing XML tag </${name}>.`);
    }
    if (node.name !== name) {
      throw new Error(`Expected </${node.name}> before </${name}>.`);
    }
  }

  private readText(): void {
    const nextTagIndex = this.xml.indexOf('<', this.index);
    const endIndex = nextTagIndex === -1 ? this.xml.length : nextTagIndex;
    this.appendText(this.xml.slice(this.index, endIndex), true);
    this.index = endIndex;
  }

  private readCdata(): void {
    const startIndex = this.index + '<![CDATA['.length;
    const endIndex = this.xml.indexOf(']]>', startIndex);
    if (endIndex === -1) throw new Error('CDATA section is not closed.');
    this.appendText(this.xml.slice(startIndex, endIndex), false);
    this.index = endIndex + ']]>'.length;
  }

  private appendText(text: string, decodeEntities: boolean): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const node = this.stack[this.stack.length - 1];
    if (!node) return;
    // Preserve fast-xml-parser's trimValues behavior for each text segment we keep.
    node.text = `${node.text ?? ''}${decodeEntities ? decodeXmlEntities(trimmed) : trimmed}`;
  }

  private addNode(node: XmlNode): void {
    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      parent.children.push(node);
    } else {
      this.roots.push(node);
    }
  }

  private readName(): string {
    const startIndex = this.index;
    while (this.index < this.xml.length && isXmlNameChar(this.xml[this.index])) {
      this.index += 1;
    }
    return this.xml.slice(startIndex, this.index);
  }

  private readRequiredName(errorMessage: string): string {
    const name = this.readName();
    if (!name) throw new Error(errorMessage);
    return name;
  }

  private readAttributeValue(attributeName: string): string {
    const quote = this.xml[this.index];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`XML attribute "${attributeName}" must use a quoted value.`);
    }
    this.index += 1;
    const startIndex = this.index;
    const endIndex = this.xml.indexOf(quote, startIndex);
    if (endIndex === -1) {
      throw new Error(`XML attribute "${attributeName}" is not closed.`);
    }
    this.index = endIndex + 1;
    return decodeXmlEntities(this.xml.slice(startIndex, endIndex).trim());
  }

  private skipDeclaration(): void {
    const state: DeclarationScanState = { quote: null, bracketDepth: 0 };
    for (let cursor = this.index + 2; cursor < this.xml.length; cursor += 1) {
      if (updateDeclarationScan(state, this.xml[cursor])) {
        this.index = cursor + 1;
        return;
      }
    }
    throw new Error('XML declaration is not closed.');
  }

  private skipUntil(token: string, errorMessage: string): void {
    // Opening markup tokens are longer than or equal to their closing tokens here, so
    // this skips past the opening token without missing a valid overlapping close.
    const endIndex = this.xml.indexOf(token, this.index + token.length);
    if (endIndex === -1) throw new Error(errorMessage);
    this.index = endIndex + token.length;
  }

  private skipWhitespace(): void {
    while (this.index < this.xml.length && isXmlWhitespace(this.xml[this.index])) {
      this.index += 1;
    }
  }

  private startsWith(token: string): boolean {
    return this.xml.startsWith(token, this.index);
  }
}

type DeclarationScanState = {
  quote: string | null;
  bracketDepth: number;
};

function isXmlNameChar(char: string | undefined): boolean {
  return char !== undefined && XML_NAME_CHARS.has(char);
}

function isXmlWhitespace(char: string | undefined): boolean {
  return char !== undefined && XML_WHITESPACE_CHARS.has(char);
}

function updateDeclarationScan(state: DeclarationScanState, char: string | undefined): boolean {
  if (char === undefined) return false;
  if (updateDeclarationQuote(state, char)) return false;
  updateDeclarationBracketDepth(state, char);
  return isDeclarationEnd(state, char);
}

function updateDeclarationQuote(state: DeclarationScanState, char: string): boolean {
  if (state.quote) {
    if (char === state.quote) state.quote = null;
    return true;
  }
  if (char === '"' || char === "'") {
    state.quote = char;
    return true;
  }
  return false;
}

function updateDeclarationBracketDepth(state: DeclarationScanState, char: string): void {
  if (char === '[') {
    state.bracketDepth += 1;
    return;
  }
  if (char === ']' && state.bracketDepth > 0) {
    state.bracketDepth -= 1;
  }
}

function isDeclarationEnd(state: DeclarationScanState, char: string): boolean {
  return char === '>' && state.bracketDepth === 0;
}

function assertSafeXmlAttributeName(name: string): void {
  if (UNSAFE_XML_ATTRIBUTE_NAMES.has(name)) {
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
        default:
          return decodeNumericXmlEntity(entity, body);
      }
    },
  );
}

function decodeNumericXmlEntity(entity: string, body: string): string {
  const codePoint = body.startsWith('#x')
    ? Number.parseInt(body.slice(2), 16)
    : Number(body.slice(1));
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return entity;
  }
}
