# Simfile CLI

This folder contains the thin command-line wrapper.

Business logic belongs in `src/schema/`; command handlers should only parse
arguments, read files, call schema helpers, and format output.
