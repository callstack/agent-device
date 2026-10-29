# Third-party material

Third-party material retains its original license. The root MIT license does not
replace the licenses listed here.

## Bundled JavaScript dependencies

Each build generates `dist/src/THIRD_PARTY_NOTICES.txt` from the dependencies
included in the bundle. That file ships in the npm package with the dependencies'
license texts and applicable NOTICE contents. Dependencies resolved separately at
runtime retain the license files in their own packages.

`jpeg-js` also carries source-file notices for its decoder and encoder, beyond
the package-level BSD license. These are retained in
[`LICENSES/jpeg-js.txt`](LICENSES/jpeg-js.txt) and included with the Apache License
2.0 in the generated notice file whenever `jpeg-js` is bundled.

## Maestro conformance fixtures

The 42 upstream flows in `scripts/maestro-conformance/corpus/upstream/` are copied
without modification from [Maestro v2.5.1](https://github.com/mobile-dev-inc/Maestro/tree/v2.5.1),
commit `a4c7c95f5ba1884858f7e35efa6b8e0165db9448`, under the Apache License 2.0.
Their original paths and SHA-256 hashes are recorded in the adjacent
`scripts/maestro-conformance/corpus/manifest.json`.

The license is retained in [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
The conformance fixtures are development inputs and do not ship in the npm package.

## Gradle wrapper

The Gradle wrapper in `scripts/maestro-conformance/jvm-harness/` is licensed under
the [Apache License 2.0](LICENSES/Apache-2.0.txt).
Its wrapper scripts retain the upstream copyright notices for the original authors.

## Simulator accessibility bridge

`apple/snapshot-bridge/SnapshotBridgeRuntime.m` contains code adapted from Meta's
idb v1.5.2. Its MIT copyright notice and license are retained in
[`apple/snapshot-bridge/LICENSE.idb`](apple/snapshot-bridge/LICENSE.idb), which also
ships with the bridge in the npm package.
