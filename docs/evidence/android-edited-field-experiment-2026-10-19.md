# Android edited-field experiments, 2026-10-19

The safe result is a clear-verification fix: a field that moves after being cleared now confirms its empty value by a corroborated identity. Four moving-field trials previously changed the correct field but returned an error after a median 1636.5 ms. At the measured runtime, all four succeeded, with a median 322.5 ms: 1314 ms saved per affected clear.

The larger adapter timer shortcut was rejected. It saved seconds in normal tests but clicked a covering button in three oracle trials, even though the requested field was correctly cleared. Exact value assertions alone miss that side effect.

[Machine-readable results](android-edited-field-experiment-2026-10-19-results.json) retain inputs, outcomes, and validation counts. [The preceding startup experiment](android-startup-experiment-2026-10-19.md) remains a separate rejected policy.

## Inputs and isolation

The runtime base was `8b29f466fc2941eb24f9b3df8b60b3aef862d8cd`. The measured runtime was `86d42d43ea2a06cc4290fb1bef56b780765b7d1c`. The adapter was `5e1d8952f4b0fd0d6a12b084ed8151e71e7cd889`. Separate disposable checkouts received independent dependency installations and builds. Runs used Pixel_7_CI / emulator-5554, Android 16 API 36, sequentially, one worker, and zero runner retries. No heavy tests or builds ran beside device timings.

The benchmark APK SHA-256 remained `b163e985ebd8340bf10447cdf6826aea37e429ee8c4382f9179c863c8c0619b2`. The test-app APK remained `4f332d39e76899b86e7006cda5d43ade6211733fe85ffe4552735e3e56c867b4`.

## Large wait found, unsafe shortcut rejected

The adapter refinds fields using role, test ID, name, and text. Android textbox text can echo the edited value. A successful edit can therefore make the same stationary field appear newly arrived, triggering the remainder of the configured 1500 ms transition timer.

The prototype admitted only a uniquely identified, previously edited, focused Android textbox. It required three complete same-app observations spanning at least 100 ms, unchanged geometry, expected value, focus, keyboard, and surface facts. Other mutations or failed actions cleared eligibility. Password fields were excluded. Native dispatch guards remained enabled.

| Same original benchmark case, ABBA | Case time | Clear | Enter |
| --- | ---: | ---: | ---: |
| Timer | 8.940 s | 1733 ms | 1617 ms |
| Measured shortcut | 6.194 s | 451 ms | 286 ms |
| Measured shortcut | 6.087 s | 436 ms | 285 ms |
| Timer | 8.866 s | 1731 ms | 1603 ms |

All four case runs passed with no fixture recoveries. Four test-app workflows also passed: 37.714 s with the timer and 32.634 s with the shortcut. These measurements belong to the rejected prototype. It did not run the full original suite.

The focused native oracle repeated seven cells three times: static, overlays at 200/250/300 ms, movement, a slide, and duplicate identity. The shortcut produced 15 correct actions, three covering-button clicks, and three errors after the correct mutation. The timer produced 12 correct actions and nine refusals with no activation. These selected timing cells demonstrate counterexamples; they do not estimate production failure rates.

Each trial checked a unique trial token, exactly one target clear, unchanged decoy text, zero decoy edits, and zero covering-button clicks after 800 ms. The failed overlay trials had both an empty target and a positive click counter. A deliberate covering-button click after a correct clear also failed the oracle as intended. Setup-failed and shortcut-ineligible preparation runs are excluded from these counts.

## Narrow verifier fix retained

The old verifier dropped a focused input when its raw text became empty. If that field moved, it instead inspected the old coordinates, saw the decoy, and exhausted its 1500 ms deadline despite a successful clear.

The fix carries the captured target through native-helper verification. Moved-field corroboration requires complete, freshly invalidated captures before and after the mutation, no missing window roots, and exactly one raw package/resource-ID match in both trees. The observed field must retain its class, be the sole focused edit, belong to the app, be nonsensitive, and have an exactly empty value. Missing or ambiguous evidence retains the existing point-verification behavior. Provider-native and shell/IME paths do not gain this corroboration.

The native fixture places a decoy at the target's old point after moving the target. With adapter transition zero in both arms, the unchanged base passed two static controls and returned four errors after correctly clearing the moving target. The measured runtime passed all six trials. Moving clears measured 299–413 ms, median 322.5 ms, versus 1620–1646 ms, median 1636.5 ms. Every trial recorded one target clear, unchanged decoy text, and no decoy edits or clicks. This is a verifier improvement, not proof that point dispatch is atomic.

## Validation

The original regression test failed on the unchanged base: one failed, four passed. Focused final coverage passed all 40 tests. Independent review found missing pre-action uniqueness proof in an earlier candidate; that finding was fixed. The matched helper-transport regression then changed from four failures and one pass at `2aaf2c6c59` to five passes at the measured runtime. The final independent source review found no remaining issues.

Both original benchmark runs had zero fixture recoveries and zero extra attempts. The historical 273.122 s run is not treated as a contemporary base. In the new pair, fill totals were 14.119/13.911 s, clear 1.731/1.754 s, and taps 83.809/83.802 s (base/head). Scrolling totals were 66.961/73.162 s. One pair cannot establish a statistical improvement or regression. The test-app scenario, command, and behavior identities match the previous full verification. Eight expected negative visibility probes preceded scroll-to-visible actions; they were not infrastructure reissues or failed mutations.

The first full CLI attempt stopped before any fill: Android was in non-touch mode after the Enter-key workflow, and focus scrolled the Automation lab heading offscreen. A visible fixture tap changed the observed input event to `inTouchMode=true`. The unchanged suite then ran with that explicit precondition. The failed setup, an interrupted premature rerun, and the repair commands remain in the archive; they are excluded from passing-run counts.

The benchmark and test-app runs used the original adapter after restoring and rebuilding it. The benchmark selected the same 42 runnable test IDs as the earlier accepted run, with one authored skip. Aggregate runs are regression evidence; this experiment makes no whole-suite speedup or experimental-engine parity claim. API 36 is the only live platform tested. Unknown capture metadata and older APIs retain the existing verification path.

Two Claude Opus public-source review rounds challenged the shortcut. The follow-up corrected an initial mistaken 500 ms timer bound to the configured 1500 ms, and identified native fill's unconditional point tap. These reviews covered public code and design, not the complete unpublished patch. The app-side counter oracle established the actual wrong-click result.

## Disposition and next target

Promote only the verifier fix. Retain the adapter timer and native input guards. The next larger experiment is identity-bound native fill/clear that can resolve and validate the target without injecting an unconditional point tap. It needs counter-based tests for overlays, duplicate IDs, remounts, keyboard movement, and touch-handler fidelity before any host wait is removed. A native accessibility action alone does not establish fidelity to custom touch handlers.

The local archive retains runtime patches/source, rejected adapter patches, fixture source/APK, harnesses, reports, logs, and per-file checksums: `android-edited-field-experiment-2026-10-19.tar.gz`, SHA-256 `a8ac1266326861aaaf821344433e7b6c4c507caa0eb56d30d864e97498f68626`. It is a local handoff artifact, not a repository-hosted download. The initial 27 owned daemon states were stopped. Both disposable checkouts were removed. The reviewed SHA and clean status were verified unchanged before promotion. Only the final guarded verifier fix was promoted.

The final code at `14a2d7a28dfa0e509e02247323aa56b72c98e1fc` separates identity corroboration from point scanning to satisfy the complexity gate. Independent review confirmed equivalent checks. All 40 focused tests and six native counter trials through the public SDK passed on this refactor. Whole-suite benchmark and test-app evidence above remains attributed to `86d42d43ea`. The first new harness run completed six correct cases but failed a duplicate final close; the corrected harness exited zero. One additional owned daemon was stopped. The post-review archive is `android-edited-field-post-review-2026-10-19.tar.gz`, SHA-256 `ba0df22db185ea4d5134082866687a1a9317e26e94b4bcb815fbfe03f8dce28e`.
