---
title: Handoff 2026-09-16 - Automatic Herdr setup
status: Provisional
updated: 2026-09-16
---

# Handoff

## Summary
pi-robot 0.1.1 automatically installs missing Herdr through the official platform installer.

## Current State
Installer tests, packaged production lifecycle and bundle smoke pass; publishing and remote update verification pending.

## Git And Persistent State
- Branch: main, origin woertedetiankong/pi-robot.
- Existing local Herdr and user pi settings remain unchanged.

## Cross-Module References
- package.json postinstall calls scripts/install-herdr.mjs using only Node built-ins.
- The six bundled skills and existing Herdr state bridge remain the integration entrypoints.
- Previous bundle: [handoff](../2026-09-16-bundle/handoff.md).

## Validation
- npm run test:installer: 10 passed.
- npm install --package-lock-only: actual lifecycle reused existing Herdr 0.9.0.
- Production tarball npm install --omit=dev: hook executed and reused existing Herdr.
- npm test: bundle commands, six skills and real Monty query passed.

## Restart Verify
```sh
npm run test:installer # expected: 10 passed; mismatch means installer regression
 git status --short # expected: implementation files until committed; mismatch means inspect ongoing edits
```

## Next Steps
1. Verify packaged lifecycle and integration; publish and verify actual pi update.

## Implementation Log
See [implementation-log.md](implementation-log.md).
