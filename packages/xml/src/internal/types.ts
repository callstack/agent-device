export type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  text: string | null;
  children: XmlNode[];
};

export type XmlParseOptions = {
  maxDocumentChars?: number;
};
