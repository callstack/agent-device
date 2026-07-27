// The public API vocabulary for the read commands that resolve a selector (get / is / find).

import type { FindLocator } from '../selectors/find.ts';
import type {
  FindSnapshotCommandOptions,
  SelectorSnapshotCommandOptions,
} from './client-capture.ts';
import type { DeviceCommandBaseOptions } from './client-connection.ts';
import type { ElementTarget } from './client-target.ts';

/**
 * #1271 stage 2 (ADR 0012 amendment): `get`/`is`/`find` are observation-only
 * and excluded from a repair-armed heal by default. `record` forces this
 * action through (the corrective-read case); `noRecord` continues to opt the
 * action out entirely. Mutually exclusive.
 */
export type RecordControlOptions = {
  noRecord?: boolean;
  record?: boolean;
};

export type GetOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  ElementTarget &
  RecordControlOptions & {
    format: 'text' | 'attrs';
  };

export type IsTextPredicateOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  RecordControlOptions & {
    predicate: 'text';
    selector: string;
    value: string;
  };

export type IsStatePredicateOptions = DeviceCommandBaseOptions &
  SelectorSnapshotCommandOptions &
  RecordControlOptions & {
    predicate: 'visible' | 'hidden' | 'exists' | 'editable' | 'selected' | 'focused';
    selector: string;
    value?: never;
  };

export type IsOptions = IsTextPredicateOptions | IsStatePredicateOptions;

export type FindBaseOptions = DeviceCommandBaseOptions &
  FindSnapshotCommandOptions &
  RecordControlOptions & {
    locator?: FindLocator;
    query: string;
    first?: boolean;
    last?: boolean;
  };

export type FindOptions =
  | (FindBaseOptions & { action?: 'click' | 'focus' | 'exists' | 'getText' | 'getAttrs' })
  | (FindBaseOptions & { action: 'wait'; timeoutMs?: number })
  | (FindBaseOptions & { action: 'fill' | 'type'; value: string });
