import type { LayeringViolation } from './model.ts';

/** A violation before the parametrized gate stamps its row's rule id. */
export type UnruledViolation = Omit<LayeringViolation, 'rule'>;

export type CutoverCheck = (sources: ReadonlyMap<string, string>) => UnruledViolation[];

/** At least one element, so "declared but empty" cannot satisfy a mandatory claim. */
export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * What a migrated command must retire. A row declares every form that applies to it;
 * `cutoverRowDefects` requires at least one, because a cutover that retires nothing is
 * not a cutover.
 */
export type LegacyRetirementClaim = Readonly<{
  /** Retired module paths that must not exist in production. */
  modulePaths?: readonly string[];
  /** Retired module path shapes (matched against the repo-relative path). */
  modulePathPatterns?: readonly RegExp[];
  /** Import/re-export specifiers of retired modules, static or dynamic. */
  importPatterns?: readonly RegExp[];
  /** Retired executable names, scanned across all production sources. */
  routeNames?: readonly string[];
  /** Retired executable names scanned in `src/daemon/` production only. */
  daemonOnlyRouteNames?: readonly string[];
  /** Legacy provider methods the daemon may not call (`provider.dumpNetwork`). */
  daemonOnlyProviderMethods?: readonly string[];
  /** `PlatformPlugin` facet keys retired with the legacy adapter. */
  pluginFacetKeys?: readonly string[];
  /**
   * Static platform command sets this command's admission DATA was removed from — the whole
   * retirement of a command whose legacy admission was a capability bucket plus set membership,
   * with no adapter module, route, or dispatch projection to name.
   *
   * Every other form above names something that must NOT exist, which a row can satisfy by
   * inventing a name that never existed. This one is two-sided and cannot: each named set must
   * still EXIST in production source, and must no longer list the command. A fictional set fails
   * the first half, a skipped deletion the second.
   */
  staticCommandSets?: readonly string[];
}>;

/**
 * Command-keyed plugin admission members. Form and file scope differ per row because
 * the same syntax means admission for one command and opaque identifier data for
 * another — `PUBLIC_COMMANDS.record` is live session-event data.
 */
export type AdmissionMemberClaim = Readonly<{
  forms: NonEmpty<'computed-property' | 'public-commands-member'>;
  /** Undefined scans every production source. */
  files?: readonly string[];
  message: string;
}>;

/** Which operations belong to this command: an exact set, or an input-dependent family. */
export type OperationClaim =
  | Readonly<{ names: NonEmpty<string>; pattern?: RegExp }>
  | Readonly<{ names?: undefined; pattern: RegExp }>;

export type CutoverIdentity = Readonly<{
  /** Layering rule id. Per row, so the report keeps each cutover's identity. */
  rule: string;
  /** Canonical descriptor name: drives admission, descriptor, and static-set checks. */
  command: string;
  /** Noun used in prose for this command's mechanics ('recording', 'device inventory'). */
  subject: string;
  /**
   * ADR 0019 §8 evidence tier. A `durable-resource` row must carry a lifecycle proof;
   * a request-scoped row must not need one.
   */
  tier: 'request-scoped' | 'durable-resource';
  legacyRetirement: LegacyRetirementClaim;
  admissionMember?: AdmissionMemberClaim;
  /** Assertions that do not generalize. Stamped with this row's rule id. */
  extensions?: readonly CutoverCheck[];
  /** Required iff `tier` is `durable-resource`. */
  lifecycleProof?: CutoverCheck;
}>;

/**
 * An inventory command binds no device runtime, so its singular-execution proof is the
 * identity of the one gateway binding its handler must import and call.
 */
export type InventoryCutover = CutoverIdentity &
  Readonly<{
    execution: 'inventory';
    singularExecution: Readonly<{ gatewayProof: CutoverCheck }>;
  }>;

/**
 * A host-diagnostic command (ADR 0019 `host` execution) binds no device runtime either: its
 * singular-execution proof is the identity of the neutral host-diagnostics surface its handler
 * must consume, mirroring the inventory shape.
 */
export type HostCutover = CutoverIdentity &
  Readonly<{
    execution: 'host';
    singularExecution: Readonly<{ gatewayProof: CutoverCheck }>;
  }>;

type DeviceRuntimeBase = CutoverIdentity &
  Readonly<{
    execution: 'device-runtime';
    runtimeTypeNames: NonEmpty<string>;
    /**
     * `declared` checks this row's operations. `any-operation` covers every daemon
     * runtime operation, which a row whose operation set is input-dependent needs.
     */
    nonNullRepairScope?: 'declared' | 'any-operation';
  }>;

/**
 * A command that names its operations exactly must also enforce each of them exactly
 * once. Knowing the whole operation set and checking only the route would leave the
 * operations themselves free to be called twice or not at all.
 */
type NamedOperationCutover = DeviceRuntimeBase &
  Readonly<{
    operations: Readonly<{ names: NonEmpty<string>; pattern?: RegExp }>;
    singularExecution: Readonly<{
      /** Daemon route functions that must be called exactly once. */
      routes: NonEmpty<string>;
      /** Narrowed operations that must be called exactly once — the named set. */
      operations: NonEmpty<string>;
      /**
       * Lexical function owner for each narrowed operation call. An unrelated daemon
       * caller must neither satisfy a missing command call nor create a false duplicate.
       */
      operationOwners: Readonly<Record<string, NonEmpty<string>>>;
    }>;
  }>;

/**
 * A command whose operation set is input-dependent (the app-log plan picks its
 * operations from the request) cannot name a fixed set to enforce, so route
 * singularity is the whole claim. Route-only singularity is permitted here alone.
 */
type PatternOperationCutover = DeviceRuntimeBase &
  Readonly<{
    operations: Readonly<{ names?: undefined; pattern: RegExp }>;
    singularExecution:
      | Readonly<{
          routes: NonEmpty<string>;
          routeProof?: undefined;
          operations?: undefined;
          operationOwners?: undefined;
        }>
      | Readonly<{
          routes?: undefined;
          routeProof: CutoverCheck;
          operations?: undefined;
          operationOwners?: undefined;
        }>;
  }>;

/**
 * A device-runtime command must prove its narrowing (which types re-widen a bound
 * runtime, which operations are its own) and that its execution is singular.
 */
export type DeviceRuntimeCutover = NamedOperationCutover | PatternOperationCutover;

/**
 * One migrated command's cutover row (ADR 0019 §6/§8). The gate that reads this table
 * proves the command has exactly one platform-execution path.
 *
 * The union is discriminated by `execution` and its claims are mandatory, so a row is
 * not a place to opt out of enforcement: adding a command means stating what it
 * retired, how its admission is derived, and what makes its execution singular.
 * `cutoverRowDefects` rejects the claims the type system cannot require.
 */
export type MigratedCommandCutover = InventoryCutover | HostCutover | DeviceRuntimeCutover;

const RETIREMENT_FORMS = [
  'modulePaths',
  'modulePathPatterns',
  'importPatterns',
  'routeNames',
  'daemonOnlyRouteNames',
  'daemonOnlyProviderMethods',
  'pluginFacetKeys',
  'staticCommandSets',
] as const satisfies readonly (keyof LegacyRetirementClaim)[];

/**
 * Cross-field claims the type system cannot express. Returns one message per defect so
 * an incomplete row fails the gate instead of passing with nothing to enforce.
 *
 * Reads defensively: a row that omits whole claim objects is exactly the input this
 * rejects, so it must not depend on them being present.
 */
/**
 * Rule ids name a row in the layering report, so two rows sharing one id silently merge their
 * violations under a single heading. Sibling stacks that each add rows to this table are the way
 * that happens, so the table — not the reader — rejects it.
 */
export function cutoverTableDefects(table: readonly MigratedCommandCutover[]): string[] {
  const byRule = new Map<string, string[]>();
  for (const row of table) {
    const commands = byRule.get(row.rule);
    if (commands) commands.push(row.command);
    else byRule.set(row.rule, [row.command]);
  }
  return [...byRule.entries()]
    .filter(([, commands]) => commands.length > 1)
    .map(
      ([rule, commands]) => `rule id ${rule} is claimed by ${sortedUnique(commands).join(', ')}`,
    );
}

export function cutoverRowDefects(row: MigratedCommandCutover): string[] {
  const defects: string[] = [];
  if (!hasAnyRetirementForm(row.legacyRetirement)) {
    defects.push('declares no legacy retirement form');
  }
  if (row.tier !== 'request-scoped' && row.tier !== 'durable-resource') {
    defects.push('declares no evidence tier');
  }
  if (row.tier === 'durable-resource' && row.lifecycleProof === undefined) {
    defects.push('is durable-resource tier but declares no lifecycle proof');
  }
  if (row.tier === 'request-scoped' && row.lifecycleProof !== undefined) {
    defects.push('is request-scoped tier but declares a durable lifecycle proof');
  }
  defects.push(...executionDefects(row));
  return defects;
}

function executionDefects(row: MigratedCommandCutover): string[] {
  if (row.execution === 'inventory' || row.execution === 'host') {
    return row.singularExecution?.gatewayProof === undefined
      ? ['declares no singular gateway proof']
      : [];
  }
  if (row.execution !== 'device-runtime') return ['declares no execution kind'];
  const defects: string[] = [];
  if ((row.runtimeTypeNames?.length ?? 0) === 0) defects.push('declares no runtime type names');
  if (!hasOperationClaim(row.operations)) defects.push('declares no operations');
  if (
    (row.singularExecution?.routes?.length ?? 0) === 0 &&
    row.singularExecution?.routeProof === undefined
  ) {
    defects.push('declares no singular daemon route');
  }
  defects.push(...namedOperationDefects(row));
  return defects;
}

/**
 * The named set and the enforced set must be the same set, each listed once. Equality
 * has to hold in both directions: an unenforced name leaves an operation free to be
 * called twice or never, and an enforced name the row does not claim asserts singularity
 * over an operation this command does not own. Route-only singularity stays available to
 * pattern-only rows, whose operations are not knowable statically.
 */
function namedOperationDefects(row: DeviceRuntimeCutover): string[] {
  const named = row.operations?.names ?? [];
  if (named.length === 0) return [];
  const enforced = row.singularExecution?.operations ?? [];
  if (enforced.length === 0) {
    return ['names its operations but enforces none of them exactly once'];
  }

  const defects: string[] = [];
  defects.push(...duplicateDefects('names', named));
  defects.push(...duplicateDefects('enforces', enforced));

  const enforcedSet = new Set(enforced);
  const namedSet = new Set(named);
  const unenforced = named.filter((name) => !enforcedSet.has(name));
  const unnamed = enforced.filter((name) => !namedSet.has(name));
  if (unenforced.length > 0) {
    defects.push(
      `names operations it does not enforce exactly once: ${sortedUnique(unenforced).join(', ')}`,
    );
  }
  if (unnamed.length > 0) {
    defects.push(`enforces operations it does not name: ${sortedUnique(unnamed).join(', ')}`);
  }
  const owners = row.singularExecution?.operationOwners ?? {};
  const owned = Object.keys(owners);
  const ownerless = named.filter((name) => (owners[name]?.length ?? 0) === 0);
  const unclaimedOwners = owned.filter((name) => !namedSet.has(name));
  if (ownerless.length > 0) {
    defects.push(`names operations without lexical owners: ${sortedUnique(ownerless).join(', ')}`);
  }
  if (unclaimedOwners.length > 0) {
    defects.push(
      `declares lexical owners for unnamed operations: ${sortedUnique(unclaimedOwners).join(', ')}`,
    );
  }
  for (const [operation, lexicalOwners] of Object.entries(owners)) {
    const duplicates = duplicateValues(lexicalOwners);
    if (duplicates.length > 0) {
      defects.push(`declares duplicate lexical owners for ${operation}: ${duplicates.join(', ')}`);
    }
  }
  return defects;
}

function duplicateDefects(verb: 'names' | 'enforces', values: readonly string[]): string[] {
  const duplicates = duplicateValues(values);
  return duplicates.length === 0 ? [] : [`${verb} duplicate operations: ${duplicates.join(', ')}`];
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = values.filter((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
  return sortedUnique(duplicates);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function hasAnyRetirementForm(claim: LegacyRetirementClaim | undefined): boolean {
  if (claim === undefined) return false;
  return RETIREMENT_FORMS.some((form) => (claim[form]?.length ?? 0) > 0);
}

function hasOperationClaim(claim: OperationClaim | undefined): boolean {
  if (claim === undefined) return false;
  return (claim.names?.length ?? 0) > 0 || claim.pattern !== undefined;
}
