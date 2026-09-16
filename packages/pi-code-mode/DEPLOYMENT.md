# Deployment Guide

Everything needed to take this checkout to a published, installable pi plugin. Each stage
is independent — you can stop after local install and publish later.

## 0. Prerequisites

- **Node.js ≥ 22.19** (`node --version`). Both pi and this package require it; the code
  ships as TypeScript and relies on Node's built-in type stripping (stable since 22.18),
  so there is no build step anywhere in this guide.
- **A platform monty supports.** `@pydantic/monty` ships its native binding + `monty`
  worker binary via npm platform packages for: macOS x64/arm64, Linux x64/arm64 (glibc),
  Windows x64. Anything else needs a source build with `MONTY_BIN` pointing at the binary.
- **WSL2 users**: keep the checkout on the Linux filesystem (e.g. `~/pi-code-mode`), not
  under `/mnt/c` or `/mnt/d`. Importing pi's package from a Windows-mounted drive takes
  ~70 s per pi startup vs. ~1 s on ext4 (measured on this repo). The code works either
  way; only startup latency differs.

## 1. Verify on your machine

```bash
cd pi-code-mode
npm ci                 # exact, locked dependency install
npm run typecheck      # tsc --noEmit
npm test               # unit and integration tests against the real monty worker pool
npm run smoke          # end-to-end deployment check, prints PASS/FAIL per capability
```

`npm run smoke` is the canary for machine-specific problems: it exercises the monty
platform binary, worker pool startup, the sandbox boundary, the type-check gate, and
state persistence — without needing pi or an API key. If smoke passes here, the extension
will work inside pi on this machine.

## 2. Install into pi locally

Three options, in increasing permanence:

```bash
# a) One session (also ideal while developing):
pi -e /path/to/pi-code-mode/src/pi/extension.ts

# b) Every session, from your checkout (survives edits — pi loads TS directly):
ln -s /path/to/pi-code-mode ~/.pi/agent/extensions/pi-code-mode

# c) Via pi's package manager, from the local directory:
pi install /path/to/pi-code-mode
```

pi's extension loader (jiti) resolves `@pydantic/monty` and `typebox` from this package's
own `node_modules`, so **`npm ci` must have run in the checkout first**.
`@earendil-works/pi-coding-agent` itself is a peer dependency satisfied by pi at runtime
(it is also a devDependency here so the test suite can exercise the real tool bridge).

### Trying it out

Ask pi something that rewards composition, e.g.:

> Use the code tool to count lines per file under src/ and print the three largest.

Useful interactions:

- Gated calls (`bash`/`edit`/`write` from inside Python) pop an approval dialog. Choosing
  **"Decide later"** suspends the script; resume with `{"resume": true}` (the model knows
  this) or discard with `{"abandon": true}` — both work even after restarting pi.
- `/code-reset` clears the Python session.
- State survives pi restarts automatically (it rides in the session file).

## 3. Publish to npm

Pre-flight, once:

1. Pick the final package name. Check availability: `npm view <name>` should 404.
   If you rename, update `name` in `package.json` and the `pi-code-mode/pi` import in
   README examples.
2. Fill in `package.json` publish metadata: `author`, `repository.url`, `homepage`,
   `bugs` (copy the shape from any published package). Set `version` to `0.1.0`.
3. Update `LICENSE`: replace "pi-code-mode contributors" with your name if you prefer.
4. `npm whoami || npm login` (enable 2FA on the account; npm requires OTP on publish).

Publish:

```bash
npm ci && npm run typecheck && npm test && npm run smoke   # never publish red
npm publish --access public --dry-run                       # inspect the file list first
npm publish --access public
```

What ships is controlled by `files` in package.json: `src/`, `README.md`, `LICENSE` —
no build artifacts, no tests. The `pi-package` keyword is already set; that is what makes
the package discoverable as a pi plugin (the pi.dev/packages listing indexes npm by that
keyword). After publishing, anyone installs it with:

```bash
pi install npm:<your-package-name>
```

### Versioning discipline

- `npm version patch|minor` (creates the git tag too), then re-run the publish block.
- Treat changes to `SerializedState` (src/core/session.ts) as **breaking**: old pi session
  files carry serialized state from prior versions. The restore path already degrades
  gracefully (unreadable state → fresh session, never a crash), but call it out in
  release notes.

## 4. Open-source the repository

```bash
cd pi-code-mode
git init -b main
git add .
git commit -m "pi-code-mode: code-mode plugin for pi on monty 0.0.23"
gh repo create <your-org>/pi-code-mode --public --source . --push
```

Already in the tree for you:

- `LICENSE` (MIT), `README.md` (includes credits to pi-code-tool for the UX design —
  keep that section; the design lineage is real).
- `.github/workflows/ci.yml` — runs typecheck + tests + smoke on Linux/macOS/Windows,
  which doubles as continuous verification of monty's platform binaries.
- `.gitignore` (excludes `node_modules/`, `scratch/`, `dist/`).

Suggested repo topics for discoverability: `pi`, `pi-package`, `code-mode`, `monty`,
`sandbox`, `llm-tools`.

## 5. Dependency policy (important)

- **`@pydantic/monty` is pinned exactly to `0.0.23` — keep it pinned.** Monty's API
  and serialized interpreter format can change between releases. Keep the
  `MONTY_VERSION` checkpoint marker in `src/core/session.ts` in sync with the pin.
  This upgrade intentionally rejects legacy `v: 1` checkpoints and paused scripts;
  finish pending work before upgrading if its interpreter state must be retained.

  To upgrade: bump the exact version, then `npm ci && npm test && npm run smoke`. The
  test suite covers every monty surface this package touches (feedStart snapshots,
  dump/loadSession, loadSnapshot, typeCheckStubs, watchdog), so a green run is a meaningful
  compatibility statement. The capability probes (`src/core/capabilities.ts`) self-adjust
  the prompt and type-checker workarounds to the installed monty.
  Verify mount OS-call dispatch, handle release, and suspension budget renewal too.
  A fresh checkout is used per run/resume because native suspension counts are
  cumulative per checkout. This adds a heap restore between snippets, not replay.
- **`typebox` is pinned to pi's own version** (1.1.38). If pi bumps theirs, match it.
- **pi compatibility**: the bridge imports `create*Tool` factories and `truncateHead`
  from `@earendil-works/pi-coding-agent` (verified against 0.80.6). CI + `npm test`
  catch renames when you bump the devDependency.

## 6. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Cannot find module '@pydantic/monty-linux-x64-gnu'` (or similar) | Platform package missing — reinstall with `npm ci`; on unsupported platforms build monty from source and set `MONTY_BIN=/path/to/monty`. |
| `SyntaxError` mentioning type annotations on `node test/...` | Node < 22.18 (no type stripping). Upgrade Node. |
| pi startup takes a minute (WSL2) | Checkout lives under `/mnt/*`. Move it to the Linux filesystem (see §0). |
| Every gated call is denied in scripts/CI | Expected: headless runs have no approval UI. Opt in with `createCodeModeExtension({ autoApprove: true })`. |
| `(execution timed out and the sandbox worker was killed …)` | The 30 s per-turn watchdog fired. Raise `requestTimeout` in options if legitimate workloads need longer. |
| Session state didn't survive a restart | State above 2 MB is not persisted into the session file (by design); everything else restores automatically. A note appears only on error — check the tool result's `details.state` is non-empty. |
| Type checker rejects valid code referencing a custom tool | That tool's `params`/`returns` strings aren't valid Python type expressions; fix them (the stub validator degrades unparseable stubs to unchecked rather than blocking runs). |
