# Implementation Log

> Created: 2026-09-16

## Task
Combine the installed pi plugins into a portable Git package.

## Log

### 2026-09-16
- Chose vendored source snapshots and one root dependency manifest rather than absolute imports or Git submodules. pi Git installation runs npm install --omit=dev.
- Only the combined code-mode loader is exposed, avoiding duplicate code registration while connecting embedded-docs through its event bridge.
- Owner authorized MIT publication of the integration code and previously private embedded-docs component. Existing MIT notices and Herdr-generated notices are retained.
- Runtime and source files were copied by allowlist; local caches, sessions, credentials, node_modules and upstream Git metadata were excluded.
- codetrap FTS search returned no applicable pitfalls; hybrid search unavailable because embeddings were not initialized.
- SDK smoke passed: all component commands and six bundled skills present, one code tool, real Monty document query successful. User-level shared skills may also be discovered by the SDK; assertions target the six bundled skills.
- Production tarball installed with npm install --omit=dev; actual pi 0.85.1 RPC confirmed all five entry commands and six skills. SDK smoke against the production-only package also passed real Monty query. No model calls or inter-session messages were made.
- Commit 33c2035 published the bundle. Actual pi install from GitHub and RPC load succeeded; npm audit then identified high-severity advisories in inherited pdfjs-dist 5.6.205 and sharp 0.34.5. Updating the bundled component and root manifest to pdfjs-dist 6.3.289 / sharp 0.35.4, with PDF rendering and image crop regression checks. Original source projects remain unchanged.
- Dependency regression exposed two PDF.js 6 migration requirements: use a single compatible @napi-rs/canvas 1.0.9 and destroy the loading task rather than calling the removed document-proxy destroy method. All three document tests pass after both adjustments; production dependency audit reports zero advisories.
