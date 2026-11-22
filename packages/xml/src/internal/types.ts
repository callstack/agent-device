export type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  text: string | null;
  children: XmlNode[];
};

export type XmlParseOptions = {
  maxDocumentChars?: number;
  /**
   * When false, the text of a node keeps the spacing it is written with. Only whole segments of text
   * between tags that hold nothing but spacing are dropped, so the spacing inside a value survives.
   * Defaults to true, which trims each segment, the way `fast-xml-parser` does with `trimValues`.
   */
  trimText?: boolean;
};
