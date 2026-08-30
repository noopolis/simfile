# Example Project Guide

This directory contains complete, user-facing projects that can be copied or
run from a clean Simfile source checkout. Tests must consume these exact files;
do not keep a second fixture copy of an example.

- Examples use only documented `simfile/*` exports, emitted runtime surfaces,
  project-local files, and Node built-ins where the public authoring layer
  explicitly permits them.
- Keep every external tool path and target choice explicit. Never assume a
  sibling checkout, global installation, host name, GPU, or credential.
- An example must state any external compatibility blocker without replacing
  missing capabilities or fabricating successful evidence.
