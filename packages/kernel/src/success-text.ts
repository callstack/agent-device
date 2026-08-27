export function successText(message?: string): { message?: string } {
  return message ? { message } : {};
}

export function withSuccessText<T extends Record<string, unknown>>(
  data: T,
  message?: string,
): T & { message?: string } {
  return message ? { ...data, message } : data;
}

export function readCommandMessage(data: Record<string, unknown> | undefined): string | null {
  return typeof data?.message === 'string' && data.message.length > 0 ? data.message : null;
}
