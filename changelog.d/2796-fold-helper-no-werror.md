- Fixed (ios): runtime clang builds no longer compile with `-Werror`, so a new warning from a future
  Xcode SDK cannot break the AX bridge or fold on a user's machine that this repository cannot fix
  for them. The fold helper is now built through the same content- and toolchain-keyed build cache
  as the AX bridge, so a fold call after the first serves a cached binary instead of recompiling
  `Fold.m` on every call, and switching `DEVELOPER_DIR` busts the cache instead of serving a binary
  built against a different SDK. A darwin-only CI step (`.github/workflows/ios.yml`) compiles each
  build's production argv with `-Werror` appended whenever its sources change, so a new warning still
  fails CI (#2796).
