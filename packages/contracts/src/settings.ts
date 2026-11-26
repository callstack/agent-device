import {
  AppError,
  appNotInstalledDetails,
  discloseDispatch,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import {
  APPEARANCE_ACTIONS,
  MOBILE_PERMISSION_TARGETS,
  PERMISSION_ACTIONS,
  SETTINGS,
  settingDefinition,
  SETTING_NAMES,
  SETTING_RESET_STATE,
  TEXT_SIZE_CATEGORIES,
  type AppearanceAction,
  type MobilePermissionTarget,
  type PermissionAction,
  type SettingDefinition,
  type SettingForm,
  type SettingName,
  type SettingsAppScope,
  type SettingsTargetFamily,
  type TextSizeCategory,
} from './settings-catalog.ts';

/**
 * What `text-size` answers with. The ladder is shared across platforms, so a read names the
 * category the ladder calls the device's value *and* the value the platform itself reported: an
 * Apple content-size name, or an Android `font_scale` multiplier. The ladder is coarser than any
 * one platform's own scale, and `platformValue` is what keeps a normalized answer auditable.
 */
export type TextSizeSettingPayload = Readonly<{
  setting: 'text-size';
  category: TextSizeCategory;
  platformValue: string;
}>;

/**
 * The payload a readable setting answers with, keyed by the setting that answered. Each readable
 * setting has its own shape — a category and a multiplier are not the same observation — so the
 * discriminant is what lets a response be composed, recorded, and printed from one place without
 * assuming every setting is a ladder rung. A second readable setting joins this union and supplies
 * its own sentence in `describeSettingRead`, which is where the compiler then asks for it.
 */
export type ReadSettingResult = TextSizeSettingPayload;

/** Builds the ladder's read payload, so no owner renames its keys or drops the platform value. */
export function textSizeSettingPayload(
  category: TextSizeCategory,
  platformValue: string,
): TextSizeSettingPayload {
  return Object.freeze({ setting: 'text-size', category, platformValue });
}

/** The one sentence a settings read answers with, per payload shape rather than per call site. */
export function describeSettingRead(result: ReadSettingResult): string {
  return `Text size is ${result.category}`;
}

/**
 * The sentence a settings mutation answers with. It belongs to the vocabulary rather than the daemon
 * because it is a claim about the setting: `clear-app-state` names the app it cleared and `text-size`
 * names the rung it applied, and both are the same words whoever performs the write.
 */
export function describeSettingWrite(
  setting: string,
  state: string,
  appBundleId: string | undefined,
): string {
  if (setting === 'clear-app-state') return `Cleared user data for ${appBundleId}`;
  if (setting === 'text-size') return `Text size set to ${state}`;
  if (setting === 'timezone') {
    return state === SETTING_RESET_STATE
      ? 'Time zone reset to the device default'
      : `Time zone set to ${state}`;
  }
  if (setting === 'locale') {
    return state === SETTING_RESET_STATE
      ? 'Locale reset to the device default'
      : `Locale set to ${state}`;
  }
  return `Updated setting: ${setting}`;
}

export type SettingOptions = {
  permissionTarget?: string;
  permissionMode?: string;
  latitude?: number;
  longitude?: number;
};

/** The settings a simulator changes through `simctl` alone, whichever host runs that `simctl`. */
type SimctlSetting = 'appearance' | 'permission' | 'location';

/**
 * Runs one `simctl` argv on the simulator. It resolves with the output when `simctl` exits 0 and
 * rejects with a `COMMAND_FAILED` AppError whose `details.stderr` is the `simctl` stderr otherwise.
 */
type SimctlSettingRunner = (
  args: string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/** One simulator setting the Apple `simctl` plan changes, whichever host runs that `simctl`. */
export type SimctlSettingRequest = {
  runSimctl: SimctlSettingRunner;
  /** The simulator UDID `simctl` addresses, or `booted` where the runner reaches one simulator. */
  udid: string;
  /** The device id a refusal reports to the caller, which `udid` is not on every runner. */
  deviceId: string;
  setting: SimctlSetting;
  state: string;
  appBundleId?: string;
  /** Resolves the app a privacy change names to the bundle id `simctl privacy` writes. */
  resolveApp: (app: string) => Promise<string>;
  options?: SettingOptions;
};

/**
 * Whether naming an app on one mutation can mean anything on one target family, read from the
 * matched form's `appScope`, then the setting's own.
 */
export function settingsAppScope(
  family: SettingsTargetFamily,
  setting: string,
  state: string | undefined,
): SettingsAppScope {
  const definition = settingDefinition(setting);
  if (definition === undefined) return 'unknown';
  const form =
    definition.forms.length === 1
      ? definition.forms[0]
      : definition.forms.find((candidate) => formAcceptsState(candidate, state));
  const scope = (form && 'appScope' in form ? form.appScope : undefined) ?? definition.appScope;
  return scope?.[family] ?? 'unknown';
}

/**
 * The `settings` refusal family: a request is told what its input cannot do, paired with
 * `dispatched: no`, because the refusal runs before a device is touched.
 */
const SETTINGS_REFUSAL_REASONS = {
  /**
   * The reason a request is told its app names nothing: what a caller does about it — drop the app
   * or move to a target whose mutation is app-scoped — is the reason's meaning, so a driver can
   * branch on `error.details.reason` instead of the prose.
   */
  // The asked-for setting applies to the target itself, so the named app consumes nothing.
  appNotConsumed: { reason: 'setting_app_not_consumed' },
  // A permission's trailing positional reads as a bundle id or package, which belongs in --app.
  permissionAppPositional: { reason: 'setting_permission_app_positional' },
} as const satisfies ReasonTable<'settings'>;

/**
 * The refusal a mutation answers with when its target consumes no app: the code, sentence, typed
 * details, and hint as data, so the daemon can answer with it through its own response builder
 * rather than by unwrapping an error the CLI would then re-normalize. The `app` that named nothing
 * stays in `details` — the caller asked about that bundle id and the answer should quote it back.
 */
export function settingsAppNotConsumedRefusal(
  setting: string,
  state: string | undefined,
  app: string,
): {
  code: 'INVALID_ARGS';
  message: string;
  details: Record<string, unknown>;
  hint: string;
} {
  const described = state === undefined ? setting : `${setting} ${state}`;
  return {
    code: 'INVALID_ARGS',
    message: `settings ${described} applies to the target itself, not to an app: ${app} names nothing it can grant or revoke.`,
    details: {
      reason: SETTINGS_REFUSAL_REASONS.appNotConsumed.reason,
      dispatched: 'no',
      setting: described,
      app,
    },
    hint: `Drop the --app option and run \`settings ${described}\`, or aim the app at an app-scoped setting such as \`settings permission grant location --app ${app}\`.`,
  };
}

const SETTINGS_APP_NOT_INSTALLED_HINT =
  'Run apps --all for the exact bundle id or package name, or install the app, then retry with that id in --app.';

/**
 * Resolves the app an app-scoped mutation lands on through the owner's own app resolution, ahead of
 * anything that reaches the device. A failed resolution therefore dispatched nothing, and an app that
 * resolves to no installed app answers `app_not_installed` rather than reaching the device as a
 * literal id.
 */
export async function resolveSettingsApp<Resolved>(
  app: string,
  resolve: (app: string) => Promise<Resolved>,
): Promise<Resolved> {
  try {
    return await resolve(app);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === 'APP_NOT_INSTALLED') {
      error.details = {
        ...error.details,
        ...appNotInstalledDetails(),
        app,
        hint: SETTINGS_APP_NOT_INSTALLED_HINT,
      };
    }
    throw discloseDispatch(error, 'no');
  }
}

/** The positionals after `settings` one form accepts, as help prints them. */
function formUsage(form: SettingForm, readable: boolean): string {
  switch (form.kind) {
    case 'on-off':
      return '<on|off>';
    case 'choice': {
      const states = form.states.join('|');
      if (readable) return `[${states}]`;
      return form.states.length === 1 ? states : `<${states}>`;
    }
    case 'coordinates':
      return 'set <lat> <lon>';
    case 'permission': {
      const modes = form.modes ? ` [${form.modes.join('|')}]` : '';
      const targets = form.targets.length === 1 ? form.targets[0] : `<${form.targets.join('|')}>`;
      return `<${form.actions.join('|')}> ${targets}${modes}`;
    }
    case 'app-id':
      return '[app-id]';
    case 'value':
      return `<${form.placeholder}|${SETTING_RESET_STATE}>`;
  }
}

/** Every settings form, with settings that share a form folded into one `<a|b> <form>` line. */
function settingsUsageForms(): string[] {
  const namesByForm = new Map<string, string[]>();
  for (const name of SETTING_NAMES) {
    const definition: SettingDefinition = SETTINGS[name];
    for (const form of definition.forms) {
      const usage = formUsage(form, definition.readable === true);
      namesByForm.set(usage, [...(namesByForm.get(usage) ?? []), name]);
    }
  }
  return [...namesByForm].map(([usage, names]) =>
    names.length === 1 ? `${names[0]} ${usage}` : `<${names.join('|')}> ${usage}`,
  );
}

export const SETTINGS_USAGE_OVERRIDE = settingsUsageForms()
  .map((form) => `settings ${form}`)
  .join(' | ');

export const SETTINGS_INVALID_ARGS_MESSAGE = `settings requires ${settingsUsageForms()
  .join(', ')
  .replace(/, (?!.*, )/, ', or ')}`;

/** One line per setting: its name and its help. */
export function settingsHelpLines(): string[] {
  return SETTING_NAMES.map((name) => `${name}: ${SETTINGS[name].help}`);
}

/**
 * One validated mutation. Names and states are normalized; the app, mode, and coordinates are kept
 * as written, because the app is an id and coordinates are typed where the caller needs them.
 */
export type SettingsMutation = Readonly<{
  setting: SettingName;
  state: string;
  app?: string;
  permission?: string;
  mode?: string;
  latitude?: string;
  longitude?: string;
}>;

/**
 * Parses `settings <setting> <state> …` against the catalog. A lone readable setting is the read
 * leg, which `resolveSettingsRuntimePlan` decides before this runs.
 */
export function parseSettingsMutation(positionals: readonly string[]): SettingsMutation {
  const definition = settingDefinition(positionals[0]);
  if (definition === undefined) throw invalidSettingsArgs();
  const setting = normalizeName(positionals[0]) as SettingName;
  const state = normalizeName(positionals[1]);
  if (definition.forms.some((form) => form.kind === 'app-id')) {
    const explicitClear = state === 'clear';
    if (positionals.length > (explicitClear ? 3 : 2)) throw invalidSettingsArgs();
    const app = explicitClear ? positionals[2] : positionals[1];
    return { setting, state: 'clear', ...(app === undefined ? {} : { app }) };
  }
  const form = definition.forms.find((candidate) => formAcceptsState(candidate, state));
  if (form === undefined || state === undefined)
    throw invalidSettingState(setting, definition, state);
  return parseFormPositionals(setting, state, form, definition, positionals);
}

function parseFormPositionals(
  setting: SettingName,
  state: string,
  form: SettingForm,
  definition: SettingDefinition,
  positionals: readonly string[],
): SettingsMutation {
  switch (form.kind) {
    case 'coordinates':
      if (positionals.length !== 4) throw invalidSettingsArgs();
      return { setting, state, latitude: positionals[2], longitude: positionals[3] };
    case 'permission':
      return { setting, state, ...parsePermissionPositionals(definition, state, positionals) };
    case 'on-off':
      if (positionals.length !== 2) throw invalidSettingsArgs();
      return { setting, state: readSettingState(state) ? 'on' : 'off' };
    case 'value':
      if (positionals.length !== 2) throw invalidSettingsArgs();
      return { setting, state: parseSettingValue(setting, positionals[1] ?? '') };
    default:
      if (positionals.length !== 2) throw invalidSettingsArgs();
      return { setting, state };
  }
}

/** The target picks its form; the action and mode must then belong to that same form. */
function parsePermissionPositionals(
  definition: SettingDefinition,
  action: string,
  positionals: readonly string[],
): { permission: string; mode?: string } {
  const forms = definition.forms.filter(
    (form): form is Extract<SettingForm, { kind: 'permission' }> => form.kind === 'permission',
  );
  const permission = findVocabularyName(
    forms.flatMap((form) => form.targets),
    positionals[2],
  );
  const form = forms.find((candidate) => candidate.targets.includes(permission ?? ''));
  if (permission === undefined || form === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      `settings permission requires a target: ${forms.flatMap((candidate) => candidate.targets).join('|')}`,
    );
  }
  if (findVocabularyName(form.actions, action) === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      `settings permission ${action} does not apply to ${permission}. Use ${form.actions.join('|')}.`,
    );
  }
  if (positionals.length === 3) return { permission };
  const mode = findVocabularyName(form.modes ?? [], positionals[3]);
  if (mode !== undefined && positionals.length === 4) return { permission, mode };
  const refusal = permissionModeRefusal(permission, form.modes, mode);
  // A dotted value reads as a bundle id or package, which only an app-scoped target takes.
  const app = (MOBILE_PERMISSION_TARGETS as readonly string[]).includes(permission)
    ? positionals.slice(3).find((value) => value.includes('.'))
    : undefined;
  if (app === undefined) throw new AppError('INVALID_ARGS', refusal);
  throw new AppError('INVALID_ARGS', refusal, {
    reason: SETTINGS_REFUSAL_REASONS.permissionAppPositional.reason,
    dispatched: 'no',
    permission,
    app,
    hint: `Pass the app with --app ${app}.`,
  });
}

function permissionModeRefusal(
  permission: string,
  modes: readonly string[] | undefined,
  mode: string | undefined,
): string {
  if (modes === undefined) return `settings permission ${permission} takes no mode.`;
  if (mode === undefined) return `settings permission mode must be ${modes.join('|')}.`;
  return `settings permission ${permission} takes one mode.`;
}

function invalidSettingsArgs(): AppError {
  return new AppError('INVALID_ARGS', SETTINGS_INVALID_ARGS_MESSAGE);
}

function invalidSettingState(
  setting: SettingName,
  definition: SettingDefinition,
  state: string | undefined,
): AppError {
  const accepted = definition.forms
    .map((form) => (form.kind === 'choice' ? form.states.join('|') : formUsage(form, false)))
    .join(' | ')
    .replace('<on|off>', 'on|off');
  return new AppError(
    'INVALID_ARGS',
    state === undefined
      ? `settings ${setting} requires a state: ${accepted}.`
      : `Invalid ${setting} state: ${state}. Use ${accepted}.`,
  );
}

function formAcceptsState(form: SettingForm, state: string | undefined): boolean {
  switch (form.kind) {
    case 'on-off':
      return readSettingState(normalizeName(state)) !== undefined;
    case 'choice':
      return findVocabularyName(form.states, state) !== undefined;
    case 'coordinates':
      return normalizeName(state) === 'set';
    case 'permission':
      return findVocabularyName(form.actions, state) !== undefined;
    case 'app-id':
    case 'value':
      return true;
  }
}

/** The settings whose form is a `value`: each one validates its own value before dispatch. */
type ValueSetting = {
  [Name in SettingName]: Extract<
    (typeof SETTINGS)[Name]['forms'][number],
    { kind: 'value' }
  > extends never
    ? never
    : Name;
}[SettingName];

const VALUE_PARSERS = {
  locale: parseLocaleId,
  timezone: parseTimeZoneId,
} as const satisfies Record<ValueSetting, (value: string) => string>;

/** The value as the owners write it, or `reset`, so no device is handed a value it cannot read. */
function parseSettingValue(setting: SettingName, value: string): string {
  if (normalizeName(value) === SETTING_RESET_STATE) return SETTING_RESET_STATE;
  const parser: (raw: string) => string = VALUE_PARSERS[setting as ValueSetting];
  return parser(value);
}

const TIME_ZONE_NAME_PATTERN = /^[A-Za-z][\w+-]*(\/[\w+-]+)*$/;

/**
 * An IANA time zone name the host's time zone data knows, kept as written; the target device
 * checks it on read-back. Offsets such as `+05:30` are refused because neither owner takes one.
 */
export function parseTimeZoneId(value: string): string {
  const name = value.trim();
  if (TIME_ZONE_NAME_PATTERN.test(name) && isKnownTimeZone(name)) return name;
  throw new AppError(
    'INVALID_ARGS',
    `Invalid time zone: ${value}. Use an IANA time zone name, such as Asia/Kolkata or America/New_York.`,
  );
}

function isKnownTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** A language, an optional script, and an optional region: the parts every owner can write. */
const LOCALE_ID_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;

/**
 * The BCP 47 tag of a locale id written with `-` or `_` in any casing, such as `en-IN` for `en_in`.
 * Extensions and variants are refused: neither owner can apply them.
 */
export function parseLocaleId(value: string): string {
  const canonical = canonicalLocale(value.trim().replaceAll('_', '-'));
  if (canonical !== undefined && LOCALE_ID_PATTERN.test(canonical)) return canonical;
  throw new AppError(
    'INVALID_ARGS',
    `Invalid locale id: ${value}. Use a language with an optional script and region, such as en_IN, fr-CA, or zh-Hans-CN.`,
  );
}

function canonicalLocale(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}

function normalizeName(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

/**
 * The category a caller asked for. `simctl` exits 0 with `Invalid argument` for a category it does
 * not know, so a write never hands validation to the tool.
 */
export function parseTextSizeCategory(value: string | undefined): TextSizeCategory {
  const parsed = readTextSizeCategory(value);
  if (parsed !== undefined) return parsed;
  throw invalidSettingState('text-size', SETTINGS['text-size'], value);
}

/** The category an owner reads back, or `undefined` for a value the ladder does not name. */
export function readTextSizeCategory(value: string | undefined): TextSizeCategory | undefined {
  return findVocabularyName(TEXT_SIZE_CATEGORIES, value);
}

function findVocabularyName<const TNames extends readonly string[]>(
  names: TNames,
  value: string | undefined,
): TNames[number] | undefined {
  const normalized = normalizeName(value);
  return normalized === undefined ? undefined : names.find((name) => name === normalized);
}

export function parsePermissionAction(action: string): PermissionAction {
  const parsed = findVocabularyName(PERMISSION_ACTIONS, action);
  if (parsed !== undefined) return parsed;
  throw new AppError(
    'INVALID_ARGS',
    `Invalid permission action: ${action}. Use ${PERMISSION_ACTIONS.join('|')}.`,
  );
}

export function parsePermissionTarget(value: string | undefined): MobilePermissionTarget {
  const parsed = findVocabularyName(MOBILE_PERMISSION_TARGETS, value);
  if (parsed !== undefined) return parsed;
  throw new AppError(
    'INVALID_ARGS',
    `permission setting requires a target: ${MOBILE_PERMISSION_TARGETS.join('|')}`,
  );
}

/**
 * `simctl` and `adb` answer a bad appearance with a tool-specific error or a silent no-op, so an
 * owner parses here before a device is touched.
 */
export function parseAppearanceAction(state: string): AppearanceAction {
  const parsed = findVocabularyName(APPEARANCE_ACTIONS, state);
  if (parsed !== undefined) return parsed;
  throw new AppError(
    'INVALID_ARGS',
    `Invalid appearance state: ${state}. Use ${APPEARANCE_ACTIONS.join('|')}.`,
  );
}

function readSettingState(state: string | undefined): boolean | undefined {
  const normalized = normalizeName(state);
  if (normalized === 'on' || normalized === 'true' || normalized === '1') return true;
  if (normalized === 'off' || normalized === 'false' || normalized === '0') return false;
  return undefined;
}

/** The boolean a `settings <setting> <state>` positional spells, in any casing or padding. */
export function parseSettingState(state: string): boolean {
  const parsed = readSettingState(state);
  if (parsed !== undefined) return parsed;
  throw new AppError('INVALID_ARGS', `Invalid setting state: ${state}`);
}
