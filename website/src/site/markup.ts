// Copy in content.ts marks code with backticks. The text is escaped first, so a placeholder
// such as `<platform>` renders as text instead of being parsed as an element.
export function inlineCode(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(/`([^`]+)`/g, '<code>$1</code>');
}
