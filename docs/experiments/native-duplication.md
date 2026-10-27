# Native duplication defaults

Measured at `a16d4372376bf18eea3dff4cbe85e15fc68e7fc0` with jscpd 5.4.2 on macOS arm64.
The scans include native tests and Objective-C headers. They respect `.gitignore`, which excludes
Swift build caches, Android build output, and packaged helpers. No source exclusions were added.

## Reproduce the comparison

The table records source commit `a16d4372376bf18eea3dff4cbe85e15fc68e7fc0`.
It is an experiment record, not a target for later revisions. Files below the token minimum do
not contribute to jscpd's analyzed-file count. Percentages are its duplicated-line metric,
not unique lines to remove.

Use jscpd 5.4.2. To replay the recorded inputs without changing this checkout, extract only
tracked source from that commit:

```sh
pnpm install --frozen-lockfile
pnpm exec jscpd --version
native_dupes_source="$(mktemp -d "${TMPDIR:-/tmp}/agent-device-native-dupes.XXXXXX")"
git archive a16d4372376bf18eea3dff4cbe85e15fc68e7fc0 -- apple android linux \
  packages/platform-apple/src/core/__tests__/display-inventory.test.ts \
  packages/platform-apple/src/__tests__/simctl-facade.test.ts | tar -x -C "$native_dupes_source"
```

The version command must report `jscpd 5.4.2`. The commands below fix the worker count at two.
`--no-gitignore` lets the tracked-source archive be scanned independently of its temporary path;
the archive contains no ignored build output. Each row has a native scan and a separate scan of
the two TypeScript tests. Reports go to `.tmp/native-dupes-prototypes/`.

| Mode | Tokens / lines | Native clones | Duplicated lines | Duplication | Duo pair clones | Duo panel fragments |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| mild | 50 / 5 | 85 | 873 | 1.80% | 4 | 0 |
| weak | 50 / 5 | 82 | 857 | 1.77% | 4 | 0 |
| weak | 70 / 5 | 18 | 228 | 0.47% | 2 | 0 |
| weak | 100 / 8 | 0 | 0 | 0.00% | 0 | 0 |
| weak | 30 / 3 | 401 | 2971 | 6.12% | 16 | 0 |
| weak | 20 / 3 | 860 | 5435 | 11.20% | 31 | 2 |
| weak + consistent identifier normalization | 50 / 5 | 196 | 2150 | 4.44% | 5 | 0 |
| weak + gaps up to 8 lines | 30 / 3 | 384 | 2960 | 6.10% | 13 | 0 |

Exact commands, in table order:

```sh
# mild-50-5
pnpm exec jscpd "$native_dupes_source/apple" "$native_dupes_source/android" "$native_dupes_source/linux" --format swift,objectivec,kotlin,java,python --formats-exts objectivec:m,h --mode mild --min-tokens 50 --min-lines 5 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/mild-50-5-native
pnpm exec jscpd "$native_dupes_source/packages/platform-apple/src/core/__tests__/display-inventory.test.ts" "$native_dupes_source/packages/platform-apple/src/__tests__/simctl-facade.test.ts" --format typescript --mode mild --min-tokens 50 --min-lines 5 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/mild-50-5-duo

# weak-50-5
pnpm exec jscpd "$native_dupes_source/apple" "$native_dupes_source/android" "$native_dupes_source/linux" --format swift,objectivec,kotlin,java,python --formats-exts objectivec:m,h --mode weak --min-tokens 50 --min-lines 5 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/weak-50-5-native
pnpm exec jscpd "$native_dupes_source/packages/platform-apple/src/core/__tests__/display-inventory.test.ts" "$native_dupes_source/packages/platform-apple/src/__tests__/simctl-facade.test.ts" --format typescript --mode weak --min-tokens 50 --min-lines 5 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/weak-50-5-duo

# weak-70-5
pnpm exec jscpd "$native_dupes_source/apple" "$native_dupes_source/android" "$native_dupes_source/linux" --format swift,objectivec,kotlin,java,python --formats-exts objectivec:m,h --mode weak --min-tokens 70 --min-lines 5 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/weak-70-5-native
pnpm exec jscpd "$native_dupes_source/packages/platform-apple/src/core/__tests__/display-inventory.test.ts" "$native_dupes_source/packages/platform-apple/src/__tests__/simctl-facade.test.ts" --format typescript --mode weak --min-tokens 70 --min-lines 5 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/weak-70-5-duo

# weak-100-8
pnpm exec jscpd "$native_dupes_source/apple" "$native_dupes_source/android" "$native_dupes_source/linux" --format swift,objectivec,kotlin,java,python --formats-exts objectivec:m,h --mode weak --min-tokens 100 --min-lines 8 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/weak-100-8-native
pnpm exec jscpd "$native_dupes_source/packages/platform-apple/src/core/__tests__/display-inventory.test.ts" "$native_dupes_source/packages/platform-apple/src/__tests__/simctl-facade.test.ts" --format typescript --mode weak --min-tokens 100 --min-lines 8 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/weak-100-8-duo

# weak-30-3
pnpm exec jscpd "$native_dupes_source/apple" "$native_dupes_source/android" "$native_dupes_source/linux" --format swift,objectivec,kotlin,java,python --formats-exts objectivec:m,h --mode weak --min-tokens 30 --min-lines 3 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/weak-30-3-native
pnpm exec jscpd "$native_dupes_source/packages/platform-apple/src/core/__tests__/display-inventory.test.ts" "$native_dupes_source/packages/platform-apple/src/__tests__/simctl-facade.test.ts" --format typescript --mode weak --min-tokens 30 --min-lines 3 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/weak-30-3-duo

# weak-20-3
pnpm exec jscpd "$native_dupes_source/apple" "$native_dupes_source/android" "$native_dupes_source/linux" --format swift,objectivec,kotlin,java,python --formats-exts objectivec:m,h --mode weak --min-tokens 20 --min-lines 3 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/weak-20-3-native
pnpm exec jscpd "$native_dupes_source/packages/platform-apple/src/core/__tests__/display-inventory.test.ts" "$native_dupes_source/packages/platform-apple/src/__tests__/simctl-facade.test.ts" --format typescript --mode weak --min-tokens 20 --min-lines 3 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/weak-20-3-duo

# renamed-50-5
pnpm exec jscpd "$native_dupes_source/apple" "$native_dupes_source/android" "$native_dupes_source/linux" --format swift,objectivec,kotlin,java,python --formats-exts objectivec:m,h --mode weak --min-tokens 50 --min-lines 5 --ignore-identifiers=consistent --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/renamed-50-5-native
pnpm exec jscpd "$native_dupes_source/packages/platform-apple/src/core/__tests__/display-inventory.test.ts" "$native_dupes_source/packages/platform-apple/src/__tests__/simctl-facade.test.ts" --format typescript --mode weak --min-tokens 50 --min-lines 5 --ignore-identifiers=consistent --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/renamed-50-5-duo

# gap-30-3
pnpm exec jscpd "$native_dupes_source/apple" "$native_dupes_source/android" "$native_dupes_source/linux" --format swift,objectivec,kotlin,java,python --formats-exts objectivec:m,h --mode weak --min-tokens 30 --min-lines 3 --max-gap-lines 8 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/gap-30-3-native
pnpm exec jscpd "$native_dupes_source/packages/platform-apple/src/core/__tests__/display-inventory.test.ts" "$native_dupes_source/packages/platform-apple/src/__tests__/simctl-facade.test.ts" --format typescript --mode weak --min-tokens 30 --min-lines 3 --max-gap-lines 8 --workers 2 --no-gitignore --absolute --reporters json --output .tmp/native-dupes-prototypes/gap-30-3-duo

rm -rf "$native_dupes_source"
```

The measured native runs took about 170–195 ms each, including Node startup, using two workers.
This is a single timing sample per variant, not a performance benchmark. Linux execution belongs
to the Repo Guards & Compatibility CI job.

## Selected policy

Use weak mode with a minimum of 50 tokens and 5 lines. Weak mode removes whitespace and comments
from matching. The default mild mode adds three findings without improving either motivating
example. At 70 tokens, all seven Java findings disappear, including repeated snapshot capture and
error response handling. At 100 tokens and 8 lines, the native report is empty. At 30 tokens and
3 lines, imports, small guards, and repeated test setup dominate a much larger review backlog.
Identifier normalization also expands that backlog and still misses the Duo panels.

The selected scan analyzes 218 files and reports 82 clones: 68 Swift, 7 Java, 7 Objective-C, and
0 Python. There are no Kotlin source files in the measured trees; an executable fixture proves
Kotlin detection. The Objective-C extension mapping includes `.h`, because those headers contain
executable geometry code as well as declarations. Five header findings are declaration/implementation
pairs. Existing findings also include deliberately similar tests and Swift package manifests.
The baseline records these findings without declaring them defects or requiring extraction.

jscpd 5.4.2 has a [built-in fingerprint baseline](https://jscpd.dev/guides/baseline), introduced
in 5.1.0. A custom comparison script or percentage ceiling is unnecessary. The baseline records
content fingerprints and clone multiplicities. It tolerates line shifts and fails on a third copy
of an accepted pair. A new clone fails even if another clone is removed and the total stays equal.
The executable policy tests cover each language, headers, line shifts, extra copies, replacement
clones, missing baselines, empty scans, and removed-clone pruning.

The rollout starts with a report-only measurement and saves that result in
`native-dupes-baseline.json`. `check:native-dupes` then rejects new fingerprints or increased
multiplicities. It scans all native files rather than filtering by changed files. This keeps
unchanged files available as comparison targets and needs no Git history in CI. `check:affected`
selects it for non-documentation changes under the roots in `.jscpd-native.json`. It does not
filter by extension, so new scanner formats cannot escape selection. Some metadata changes also
select this inexpensive scan. Configuration and baseline changes select the full check set.
`--changed` is unsuitable for PR enforcement because it filters by working-tree status, which is
empty after a commit. The normal check never updates the baseline.

After rebasing onto `21f3f50a90f21bf8f994e742cbb7dd295f255d6c`, the initial baseline was
refreshed from main's native source: 82 clones, 854 duplicated lines (1.78%), and 218 analyzed
files. Three fingerprints were replaced by upstream native changes. The table above remains the
historical comparison at `a16d4372376bf18eea3dff4cbe85e15fc68e7fc0`.

## Motivating cases and limits

The closed-Duo fixtures differ at the measured revision. `display-inventory.test.ts` includes
bounds, orientation, and unique IDs absent from `simctl-facade.test.ts`. At 50 / 5, jscpd finds
shared imports and the separate single-panel fixture, but no shared closed-Duo panel fragment.
At 20 / 3, it finds two 26-token panel fragments, at `simctl-facade.test.ts:36–40` and `46–50`
against `display-inventory.test.ts:76–80` and `93–97`. It also reports 860 native clones. Enabling
gap merging cannot recover fragments below its seed token minimum. TypeScript remains owned by
Fallow; this experiment does not add a second TypeScript enforcement policy.

No matrix variant finds a clone in the checked-in `Fold.m`. A separate 10-token / 2-line probe
finds two tiny repeated fragments (lines 165–167 against 230–232, and 214–216 against 218–220).
Those are not evidence that it would catch the historical seven-line case; that original duplicated
revision was not replayed. Keep small or reimplemented logic in code review. Renamed or partially
edited copies can evade the selected exact-token policy. Reported blocks need human assessment,
especially test setup and Objective-C declarations.

## Inspect or change the baseline

Run `pnpm native-dupes:report` to inspect findings without failing on new clones. Both report and
check write `.tmp/native-dupes/jscpd-report.json`; each clone has an `isNew` field. CI uploads the
check report as `native-dupes-report` even when the check fails.

When a check reports a new clone, compare both locations and remove the repeated block when they
share an owner. If retaining duplication is intentional, review its source before running
`pnpm native-dupes:baseline`. Review the baseline diff together with the source change. Do not
regenerate it merely to clear a failing check. A detector upgrade or a change to matching options
also needs a fresh comparison and baseline review. Missing baselines and empty scans fail closed.

The normal check does not prune stale fingerprints. If a clone disappears while its fingerprint
remains in the baseline, the same block can be reintroduced up to its saved multiplicity without
failing. When removing a clone, run `pnpm native-dupes:baseline` in the same PR. jscpd's
`--update-baseline` replaces the saved fingerprints with those found by that scan, removing absent
fingerprints and reducing obsolete multiplicities. Review that the refresh removes or reduces
entries; investigate any additions. The executable pruning test proves that removal passes,
an unpruned allowance accepts reintroduction, and a refreshed baseline rejects reintroduction.
