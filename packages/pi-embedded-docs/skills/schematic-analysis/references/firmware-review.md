# Schematic to firmware review

Build a small evidence ledger: peripheral signal → exact net → MCU pin → software configuration → source → verification status.

Compare observed wiring with actual project configuration. Do not assume SDK logical pin numbers equal package pin numbers. A connection can be correct while its alternate function, polarity, pull resistor configuration or power sequencing is wrong.

Mark a suggested code change as an inference unless a supplied device reference establishes the constraint. Identify missing board revision, connector mapping, datasheet or measurement explicitly. Keep conflicts visible and preserve existing code until the user-authorized task and evidence justify changes.
