# Next Session

Project pi-robot. Read `docs/tasks/2026-09-16-herdr-install/handoff.md` first.
Previous session: implemented automatic Herdr setup with ten passing tests.
Errata: None known.
Current state: packaged verification and publishing pending.
Now do: verify production lifecycle, publish, and verify actual pi update.
Red lines: do not upgrade or stop existing Herdr; do not duplicate bundled integrations.
First verify: `npm run test:installer` (expected 10 passed; mismatch means installer regression).
