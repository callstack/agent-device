const SAFE_SHELL_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

export function shellQuoteIfNeeded(value: string): string {
  return SAFE_SHELL_ARG.test(value) ? value : shellQuote(value);
}
