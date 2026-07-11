# Maestro Conformance Fixtures

The harness compares the supported `agent-device` Maestro flow model with a
small, checked-in capture of the Maestro 2.5.1 command model. The upstream tag,
commit, source paths, and SHA-256 values live in
`upstream-maestro-2.5.1.json`.

The default check is deterministic and does not need Java or Maestro:

```sh
node --experimental-strip-types scripts/maestro-conformance.ts
```

The raw capture is normalized into `normalized-maestro-2.5.1.json`. Regenerate
that file only after reviewing an intentional upstream capture update:

```sh
node --experimental-strip-types scripts/maestro-conformance.ts --regenerate
```

The capture includes fixture source locations so the comparison also protects
`runFlow` include provenance. Timestamps and internal action names are removed
before comparison.
