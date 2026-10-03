// Payload value vocabulary shared by the validation generators (#1781 B2).
//
// Benign, occasionally hostile values used for CLI positionals/flag values and Maestro scalars.
// No leading '-': a dash token would be read as a flag and the case would die in the token scan,
// which is the classic targets' job — these generators exist to reach past it.

export const SAFE_VALUES = [
  'com.example.app',
  'text=Login',
  '@e1',
  'hello world',
  '123',
  'Ünïcøde',
  '😀 emoji',
  'say "hi"',
  String.raw`a\b`,
  '',
] as const;

/** The accept expectation, shared so a valid case reads the same in both generators. */
export const ACCEPT = { outcome: 'accept' } as const;
