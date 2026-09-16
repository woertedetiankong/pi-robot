# Next Session

Project pi-robot. Read `docs/tasks/2026-09-16-herdr-install/handoff.md` first.
Previous session: published pi-robot 0.1.1 with automatic Herdr setup; ten installer tests, production lifecycle and actual pi Git update passed.
Errata: None known.
Current state: complete.
Now do: maintain the installer only when requested; keep official installation paths and tests current.
Red lines: do not upgrade or stop existing Herdr; do not duplicate bundled integrations.
First verify: `npm run test:installer` (expected 10 passed; mismatch means installer regression).
