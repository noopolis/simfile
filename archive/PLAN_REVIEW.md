# PLAN.md Review

> **Addendum (2026-08-15, after PLAN.md status update):** the plan now carries
> its own per-item statuses, which supersede the table in §1 where they
> differ. The differences are in the plan's favor — it is stricter: §9 and
> §10 are *not* done as my table said, because the behind-gate bootstrap
> still runs the manual `SPAWNFILE_TARGET_CONFIG_PRODUCER` ABI and mutates
> target/credential state before the durable journal owns recovery — both
> correctly held as P1 landing gates. The plan also resolved this review's
> naming P2s (canonicalized `--mode lifecycle-replay-smoke`, added
> `example:local`/`example:composed`, canonicalized the real example tree)
> and its out-of-scope section rightly keeps the broad receipt-first CLI
> redesign (§5 below) at ecosystem level, not in this workstream.

Verdict: the plan is sound and the cleaning direction is right, but it is not
a plan anymore — roughly 85–90% of it already exists in the uncommitted
working tree. It reads as an in-flight checklist that has drifted from the
implementation in several names. It is not overkill in scope; it is overkill
only in presentation, because it re-specifies finished work as if it were
future work. Spawnfile is *not* uniformly this clean: its target/receipt
layer is, its project layer and capabilities handshake are not.

## 1. Status per plan section (verified in the working tree)

| Plan § | Status | Note |
|---|---|---|
| §1 Repository boundary | ✅ done | No Spawnfile changes; sibling `--source ../spawnfile` rejected by test. |
| §2 Examples vs fixtures | 🟡 partial | `examples/composed-development/` fully built; `fixtures/sims/` still holds four runnable projects; tree naming diverges from plan. |
| §3 Composed project | ✅ done | Simfile, binding, composer/provider, org tree all present. |
| §4 World evidence | ✅ done | Checkpoints, ledgers, terminal signal, replay implemented. |
| §5 Smoke semantics | 🟡 done, name differs | Exists as `--mode lifecycle-replay-smoke` with its own versioned receipt (`simfile.composed-lifecycle-replay-smoke-receipt.v1`); no `--smoke` shorthand. |
| §6 Credential-free scripted | ✅ done | No auth for scripted engines; Codex requires an explicit profile. |
| §7 Standalone install | ✅ done | `dev:spawnfile:setup` enforces exactly one of `--package spawnfile@x.y.z` / absolute `--source`, packs via `npm pack`, installs isolated, records digest in gitignored `.simfile-dev/`. |
| §8 Compatibility preflight | ✅ done | Simfile-owned probe (`simfile.spawnfile-public-capability-probe.v1`) + preflight module, run before mutation. |
| §9 Docker/target ownership | ✅ done | Delegated to Spawnfile's receipt commands; no Docker inspection in Simfile. |
| §10 Recoverable bootstrap | ✅ done | Journal session, recovery command, exclusive support root. |
| §11 Bounded polling | ✅ done | Retries only the typed not-present receipt; abort-aware, timers cleaned up. |
| §12 Dev commands | 🟡 partial | `dev:spawnfile:{setup,check,run,status}` exist; `example:local` and `example:composed` missing (`dev:spawnfile:run` is the de-facto latter). |
| §13 Docs | 🟡 partial | README documents setup/check/run and smoke mode; website/CLI-reference agreement unverified. |
| §14 Tests | ✅ largely done | Example contract test, fake-Spawnfile public-surface test, package-closure verification all present. |
| §15 Spawnfile-thread coordination | ⬜ open | External dependency — see §6 below for what to ask. |
| §16 Review loop | ⬜ open | Process item; applies to the remaining work. |
| Definition of done | ⬜ blocked | Fails only because nothing is committed. |

Portability is already clean throughout: zero `file:../` deps, zero absolute
user paths in tracked files, no private-host references.

## 2. Real remaining gaps (the actual plan)

- **P1 — nothing is committed.** The entire feature set is uncommitted;
  `git stash` or a clean clone reverts to a HEAD where none of it exists. The
  Definition of Done ("clean clone runs immediately") is currently false for
  the only reason that the work isn't landed.
- **P2 — plan/implementation naming is unreconciled** (pick one side; cheapest
  is updating the plan to match reality, plus adding the two missing scripts):
  - `--smoke` (plan) vs `--mode lifecycle-replay-smoke` (impl)
  - `example:local`, `example:composed` (plan) vs only `dev:spawnfile:run` (impl)
  - `organization/agents/tester/`, `world/composer.ts` (plan) vs
    `org/agents/smoke/`, `world/composer.mjs` (impl)
- **P2 — fixtures cleanup (§2) is only half done.** `fixtures/sims/` still
  holds four runnable example projects, and `fixtures/e2e/autonomous-office-sim`
  is example-shaped; the README redirect exists but the projects remain.
- **P3 — tests-consume-the-exact-example** (§2) — an example contract test
  exists; confirm it reads the checked-in tree rather than a copy.

## 3. Is Spawnfile this clean already? No — two tiers

**Clean tier (target/receipt boundary):** every `target …` subcommand emits
one canonical versioned JSON receipt; ~100 `spawnfile.*.v1` contract IDs;
`target resolve_config` is fully generic (context, architecture, base image,
config digest) and config-free; terminal snapshot has a typed `not-present`
receipt; `lookup_operation` has typed `pending`; auth provisioning treats
model-engine auth as optional (the scripted no-credential path is real) with
an explicit Codex profile kind. This is exactly the surface the plan consumes,
and it holds up.

**Not-clean tier (everything else):**

- `compile`, `build`, `run`, `publish`, `validate`, `view`, `dev *` have no
  machine-readable output at all; `compile` forces stdout scraping to find
  the report path. `up --json` throws in image mode.
- The capabilities handshake is hard-wired to `simfile.development.v1` /
  `simfile.composed-run.v1` — the *only* accepted profiles, and the receipt
  type literally cannot report an incompatibility. There is no generic
  profile-less capabilities query.
- No schema/receipt registry command and no shipped JSON Schemas; consumers
  hand-transcribe shapes from TARGETS.md.
- The `spawnfile.simfile-run-operator-*.v1` contracts are spec'd but wired to
  no CLI command and not exported — unreachable by a CLI-only consumer.
- No mechanical import boundary: `package.json` has no `exports` field, so
  deep imports of `spawnfile/dist/**` are unrestricted; the CLI-only rule is
  convention, not enforcement.
- "No credentials" is expressed by *absence* of the auth field, so a receipt
  cannot distinguish "scripted, deliberately unauthenticated" from "auth
  forgotten".

## 4. Tension inside the plan

§8 says "use no Spawnfile `simfile.*` profile", but Spawnfile's
`compatibility` command accepts *only* `simfile.*` profiles. The
implementation resolves this correctly — Simfile's own probe checks generic
documented surfaces directly and skips `compatibility` — but the plan should
say so explicitly, and §15's checklist to the Spawnfile thread should ask for
a **generic (non-`simfile.*`) capabilities profile** plus `--json` on
`compile`/`up`(image mode). Those are the two Spawnfile-side items that would
let Simfile's preflight stop being a workaround.

## 5. Ecosystem CLI output steer

Both CLIs are half clean in the same way: some commands emit versioned JSON
receipts, others print human prose a consumer must scrape. Simfile's composed
`run` and `recover` emit receipts and `validate` has `--json`, but local `run`
prints `wrote run <id> to <dir>`. Spawnfile's `target …` commands are
receipt-perfect while `compile`/`build`/`run`/`publish`/`validate`/`auth` are
prose-only. Moltnet is meanwhile developing the curated human rendering
language (banner on `init`, ✓ step lines, aligned annotations, `Next:` block).

**Principle: every command builds a versioned receipt object first, then
renders it.**

- `--json` → the receipt verbatim: one self-identifying versioned object
  (`spawnfile.*.v1` / `simfile.*.v1`) on stdout; diagnostics on stderr; exit
  `0` success (typed states like `not-present`/`pending` count as success),
  `2` bad input, `1` operation failure; never secrets.
- default → human rendering *derived from that same receipt*: ✓ lines per
  step, `Next:` hints, banner only on identity moments. Derivation is what
  keeps the human and machine views from drifting.
- Commands that are already JSON-always (Spawnfile `target …`, Simfile
  composed run/recover) stay JSON-always.

**Phasing:** now, align structure everywhere (receipt-first, `--json`, stream
and exit-code discipline, plain ✓/`Next:` skeleton); later, once the Moltnet
rendering language is fully curated, apply it across all three repos as a
renderer swap — no command logic changes.

**Home for the convention:** not `spawnfile/specs/` — those specify the
Spawnfile format and contracts, not tooling. It belongs in the ecosystem root
guide's shared conventions (the `CLAUDE.md` above the repos), naming Moltnet
as the reference implementation for the human layer; each repo then applies
it in its own `AGENTS.md`.

## 6. Recommendation

1. Rewrite PLAN.md as a short remaining-work list (§2 fixtures cleanup, the
   two `example:*` scripts, naming reconciliation) and mark the rest done.
2. Land the working tree in reviewable commits — this is the only P1.
3. Add Simfile's own output alignment to the plan: `--json` receipt for local
   `run` (and `observe` if it prints), receipt-first structure in human mode.
4. Send the Spawnfile thread three asks: a generic (non-`simfile.*`)
   capability profile; `up --json` fixed in image mode; adoption of the §5
   output contract on `compile`/`build`/`run`/`publish`/`validate`/`auth`
   (phased, `compile` first — it's the one Simfile scrapes today).
5. Put the output convention in the ecosystem root guide's shared
   conventions; each repo applies it in its own `AGENTS.md`. Keep Moltnet
   iterating the rendering layer independently.
