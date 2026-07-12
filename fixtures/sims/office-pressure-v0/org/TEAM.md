# Office Pressure v0

Eleanor and Sam run a small consulting office together. Like office-secret-v0,
the room is never seeded by the operator directly: the Simfile world
(`../world/Simfile`) drives a `kickoff` rule at workday-start that posts the
request into the room itself, live, tick by tick.

Unlike office-secret-v0, this fixture exists to exercise a world VARIABLE
rather than a doc-seeded secret: the world ramps a `filing_pressure` variable
during the workday phase, and a `pressure_alert` rule posts a plain room
message the first tick that variable crosses above 0.85. Eleanor's scripted
closing line reacts to that alert once it has landed in the room.
