# Implementation Log

> Created: 2026-09-16

## Task
Install Herdr along with the plugin bundle.

## Log

### 2026-09-16
- The user explicitly requested installing Herdr as part of pi-robot. The official agent guide documents install.ps1 for Windows and install.sh for macOS/Linux. Scripts were inspected through OpenCLI; the upstream installers verify binary SHA-256 and install in user locations.
- Chose an npm postinstall hook because pi Git installation executes npm install --omit=dev. The hook uses only Node built-ins, runs platform commands with argument arrays, and leaves existing Herdr versions intact.
- Installation is mandatory by default: errors are propagated instead of reporting a complete installation without Herdr. PI_ROBOT_SKIP_HERDR is an explicit opt-out; setup:herdr supports retry and environments disabling lifecycle scripts.
- No Herdr integration install command is run: the bundle already includes its skill and state bridge, so installing another copy would duplicate handlers.
- codetrap FTS returned one unrelated database-deletion card; no applicable installer lesson found.
- Ten installer tests passed; actual npm lifecycle on Windows detected Herdr 0.9.0 without download or mutation. Missing-install paths on Windows/macOS/Linux are mocked, not real OS installation tests.
- Production npm tarball includes scripts/install-herdr.mjs. npm install --omit=dev executed postinstall and preserved existing Herdr. Bundle smoke still passes all five commands, six skills and real Monty document query.
