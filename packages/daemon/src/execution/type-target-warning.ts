export function findMistargetedTypeRefToken(value: string | undefined): string | null {
  const first = value?.trim().split(/\s+/, 1)[0];
  if (!first || !first.startsWith('@') || first.length < 3) {
    return null;
  }
  const body = first.slice(1);
  if (/^[A-Za-z_-]*\d[\w-]*$/i.test(body) || /^(?:ref|node|element|el)[\w-]*$/i.test(body)) {
    return first;
  }
  return null;
}
