# Public Test-Support Guide

This folder contains intentionally exported, narrow testing authorities.

- Exports must remain generic and must not encode a fixture, local checkout,
  target, credential, or service lifecycle.
- Keep helpers deterministic and bounded; every port, poll, and controller
  must have an explicit owner and terminal condition.
- Production modules must not import this folder.
