# Registers and initialization

For each relevant field record exact name/address, width, access semantics, reset value, intended value, conditions and source. Check reserved bits, write-one-to-clear bits, read side effects, endian/alignment requirements and atomicity where the source describes them. A read-modify-write can be wrong for some access semantics.

Inspect clock/power prerequisites, pin multiplexing, reset, configuration, interrupts/DMA, enable and readiness checks. This is a checklist, not a mandated order: derive the sequence, delays and polling conditions from the actual device manual and errata supplied.

Separate fixed device facts from user-selected policy (baud, sampling rate, timeout). When generating code, preserve required waits and error paths and mark unresolved facts precisely. Driver generation does not establish build, simulation or board-test success; report only verification actually performed.
