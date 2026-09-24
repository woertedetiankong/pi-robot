# Component sources and notices

- `packages/agent-evals`: https://github.com/woertedetiankong/agent-evals ? MIT; original LICENSE retained.
- `packages/pi-code-mode`: https://github.com/woertedetiankong/pi-code-mode ? MIT; original LICENSE retained.
- `packages/pi-intercom`: npm package pi-intercom 0.13.0, copyright 2026 Nico Bailon ? MIT; original LICENSE retained. This is a bundled snapshot, not a claim of original authorship.
- `packages/pi-embedded-docs`: local author-owned implementation; owner authorized MIT publication on 2026-09-16. No private upstream platform or third-party manuals are included.
- `skills/pi-teamwork`: local collaboration workflow supplied by the repository owner.
- `skills/herdr` and `extensions/herdr-agent-state.ts`: integration artifacts installed by Herdr 0.9.0 (pi integration version 8). Original generated-file notices retained; Herdr itself is not bundled. The root MIT notice does not relicense third-party Herdr artifacts.

Transitive npm dependencies retain their respective licenses. The lockfile records the resolved dependency versions. Exact component revisions where available are recorded in sources.json.

As of pi-robot 0.1.1, the installation hook invokes https://herdr.dev/install.ps1 (Windows) or https://herdr.dev/install.sh (macOS/Linux) when no working Herdr is found. Herdr binaries are downloaded and verified by its official installer; they are not vendored or relicensed by this repository.
