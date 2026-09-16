---
title: Handoff 2026-09-16 - Automatic Herdr setup
status: Complete
updated: 2026-09-16
---

# Handoff

## Summary
pi-robot 0.1.1 automatically installs missing Herdr through the official platform installer.

## Current State
Published pi-robot 0.1.1; actual pi Git update ran postinstall and reused existing Herdr successfully.

## Git And Persistent State
- Branch: main, origin woertedetiankong/pi-robot; implementation commit a01be56.
- GitHub connector published the exact tested tree after local Git credentials failed. Local original commits are preserved in local-herdr-before-api-sync.
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
- Actual pi update from GitHub: postinstall executed, preserved Herdr 0.9.0, zero dependency vulnerabilities reported.
- Missing-install platform paths use mocks; fresh OS installation was not executed.

## Restart Verify
```sh
npm run test:installer # expected: 10 passed; mismatch means installer regression
 git status --short # expected: clean after publishing; mismatch means inspect ongoing edits
```

## Next Steps
1. None - milestone complete. Future installer changes must preserve existing installs and pass test:installer.

## Implementation Log
See [implementation-log.md](implementation-log.md).
