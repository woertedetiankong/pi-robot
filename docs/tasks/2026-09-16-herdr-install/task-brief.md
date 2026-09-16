# Task Brief: Automatic Herdr setup

> Created: 2026-09-16
> Parent plan: None found
> Status: Complete

## Goal
Make the existing pi install command also install Herdr when missing.

## Success Criteria
- Existing Herdr is detected and preserved, including the managed path before PATH refresh.
- Missing Herdr invokes the official platform installer and verifies the executable.
- npm Git installation includes and runs the hook with production dependencies.
- Publish to the existing authorized pi-robot repository.

## Scope
Install hook, lifecycle wiring, tests, README and provenance documentation.

## Constraints
No server launch, upgrade or shutdown. No new duplicate pi integration installation. Preserve existing standalone Herdr installs. Make failures visible and support an explicit opt-out.

## Expected Knowledge Updates
README, THIRD_PARTY_NOTICES and task index/handoff.
