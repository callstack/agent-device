// assertTrue phase 1 (#1295) truthiness for literal/`${VAR}`-lookup conditions.
//
// Flow config, runFlow env, and runScript `output.*` values are all stored as
// strings in `MaestroExecutionContext` (see engine-context.ts), so a `${VAR}`
// lookup always resolves to a string even when the script produced a boolean,
// number, or object. Native JS truthiness would then treat every non-empty
// string — including the string "false" a stringified `output.flag = false`
// turns into — as truthy, which defeats the common
// `runScript` (compute) -> `assertTrue: ${output.x}` (consume) idiom the #1292
// decision relies on. Pin an explicit falsy-string table instead of inferring
// one from native coercion: "", "false", "0", "null", and "undefined" (exact,
// case-sensitive match) are falsy; every other string — including numeric
// strings like "42" and JSON-shaped strings like "{}"/"[]" — is truthy,
// matching upstream's own `${0}`/`${null}`/`${undefined}` falsy and
// `${123}`/objects/arrays truthy reference table. Literal booleans and numbers
// authored directly in YAML (not routed through a lookup) use native JS
// truthiness since their type survives parsing intact.
const FALSY_CONDITION_STRINGS = new Set(['', 'false', '0', 'null', 'undefined']);

export function isMaestroConditionTruthy(condition: string | number | boolean): boolean {
  if (typeof condition === 'boolean') return condition;
  if (typeof condition === 'number') return condition !== 0 && !Number.isNaN(condition);
  return !FALSY_CONDITION_STRINGS.has(condition);
}
