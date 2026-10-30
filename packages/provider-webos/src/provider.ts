export const PROVIDER = 'webos';

export type WebosOptions = Readonly<{
  /** Directory holding the ares-* CLIs when they are not on PATH (e.g. a project's node_modules/.bin). */
  aresBin?: string;
  /** ares-setup-device entry to drive when the lease names none; defaults to the ares default device. */
  device?: string;
}>;
