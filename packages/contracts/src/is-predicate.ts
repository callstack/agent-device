/** The complete predicate vocabulary accepted by the `is` command. */
export const IS_PREDICATES = [
  'visible',
  'hidden',
  'exists',
  'absent',
  'editable',
  'selected',
  'focused',
  'text',
] as const;

export type IsPredicate = (typeof IS_PREDICATES)[number];
