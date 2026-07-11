# Simfile CLI

This folder contains the thin command-line wrapper.

Business logic belongs in `src/schema/` (validate/run) or `src/observe/`
(observe); command handlers should only parse arguments, read files, call
those modules, and format output.
