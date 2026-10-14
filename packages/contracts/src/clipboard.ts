/**
 * Closed result of the `clipboard` command. Mirrors the session runtime's
 * literal return exactly (`packages/daemon/src/execution/handlers/session-clipboard.ts`): a
 * discriminated union on `action`. `read` returns the clipboard `text`; `write`
 * reports the written `textLength` plus the `successText` message. The handler
 * spreads nothing else, so each branch is closed.
 */
export type ClipboardCommandResult =
  | {
      action: 'read';
      text: string;
    }
  | {
      action: 'write';
      textLength: number;
      message: string;
    };
