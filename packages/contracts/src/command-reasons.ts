/**
 * One value of the published `error.details.reason` vocabulary and the command that raises it.
 * A command family declares its reasons as one `as const satisfies Record<string,
 * CommandReasonRow>` table, and a construction site reads `TABLE.member.reason`, so an undeclared
 * reason does not compile.
 */
export type CommandReasonRow = Readonly<{ reason: string; command: string }>;
