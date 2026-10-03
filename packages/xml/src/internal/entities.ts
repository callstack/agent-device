export function decodeXmlCharacterReferences(value: string): string {
  return value.replaceAll(
    /&(#(?:x|X)[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g,
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
          return decodeNumericXmlCharacterReference(entity, body);
      }
    },
  );
}

export function escapeXmlTextAndAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function decodeNumericXmlCharacterReference(entity: string, body: string): string {
  const codePoint =
    body.slice(0, 2).toLowerCase() === '#x'
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
