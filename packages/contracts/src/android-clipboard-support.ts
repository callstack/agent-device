/**
 * What an Android build's clipboard shell service answered when the owner asked.
 *
 * Three states, not two, because "we could not ask" is not "it works". `cmd clipboard` has no
 * shell implementation on every build, and admission has to distinguish a build that said so from
 * a probe that never got an answer — equating unknown with supported is how `capabilities` comes
 * to advertise a clipboard that execution then refuses.
 *
 * Contracts carry the typed verdict only. Turning raw adb output into it is Android tool
 * knowledge and stays with the Android owner (ADR 0019: platform output parsing belongs to the
 * owning family, never to shared vocabulary).
 */
export type AndroidClipboardShellSupport = 'supported' | 'unsupported' | 'probe-failed';
