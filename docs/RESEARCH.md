# Simfile — Prior-Art Research

Survey of prior art for the Simfile design, run 2026-07-07. Method: fan-out
web search → source extraction → claim mining across five pillars (entity/world
models, places/presence, LLM agent societies, determinism/replay,
measurement/probes). Findings are grouped by what they do to the design:
**adopt**, **warning**, **vindication**, **deferred**. Citations are the
primary sources the claims were drawn from.

## Verdict

The design survived. Every borrowed precedent — coordinate-free rooms, ECS
entities, deterministic-world/recorded-input replay, `when/expect` as temporal
logic, the mechanical (non-LLM) world — is the settled or leading choice in its
field. Three findings sharpen the two deferred modules; two are real warnings
now folded into the design; the published cost/scale numbers confirm the
honest-niche ceiling almost exactly.

---

## 1. Entity / world models

**Adopt — single-parent acyclic custody (Inform 7 / IF, 50 years).** Inform
enforces exactly `at: place | inventory | container`: every in-play item is
always in one of inventory, a container/item, or a room; rooms are never
contained; containment loops are structurally forbidden. This is Simfile's
custody component, attested by the longest-running world-model corpus.
[graham-nelson WhitePaper](https://www.cs.tufts.edu/comp/150FP/archive/graham-nelson/WhitePaper.pdf),
[Inform manual §24](https://www.inform-fiction.org/manual/html/s24.html)

**Adopt — perception is a separate layer from custody.** Inform computes
reachability/sight topologically (open/closed containers, transparency) with a
concealment flag *orthogonal* to location. Lesson: the presence wake-mask
(perception) must not be conflated with `at:` (custody).
[Inform WI 12.16/12.18](https://ganelson.github.io/inform-website/book/WI_12_16.html)

**Adopt — recursive despawn is a required lifecycle rule.** ECS scene-graph
practice: despawning a container/holder must define cascade-vs-spill for its
contents, or the world leaks orphaned entities.
[Mertens, ECS hierarchies](https://ajmmertens.medium.com/building-an-ecs-data-oriented-hierarchies-62fb2847d100),
[ecs-faq](https://github.com/SanderMertens/ecs-faq)

**Deferred — flat `container` may need a relation qualifier.** Inform overloads
one containment edge with in/on/worn/part-of. Our flat `container` is fine
until a fixture needs those distinctions; flecs-style `(relation, target)`
pairs are the escape hatch.

**Caution on ECS as performance story.** The ECS-FAQ itself hedges the
performance claim; fragmenting (archetype-per-parent) hierarchies blew up at
40k entities (10 FPS, 1.5 GB). Irrelevant at tens-of-agents scale — ECS here is
chosen for *semantic* clarity (id + components + systems = our
variables/generators/rules), not speed.

## 2. Places / presence

**Vindication — topological beats metric, as a result not a taste.** MUDs have
room topology but no intra-room position and never relied on metric space;
Dourish/Harrison's principle "space is the opportunity; place is the understood
reality" argues the spatial metaphor is worth less than designers assume. EVE
Online partitions its single shard at solar-system (room) granularity, ~1200
concurrent per zone.
[Koster, a spatial representation](https://www.raphkoster.com/games/insubstantial-pageants/a-spatial-representation/),
[Dourish/Harrison space vs place](https://www.dourish.com/publications/2006/cscw2006-space.pdf),
[EVE single-shard](https://www.gamedeveloper.com/design/infinite-space-an-argument-for-single-sharded-architecture-in-mmos)

**Strongest opposing argument (recorded honestly).** Benford's aura/nimbus
model — the ancestor of MMO interest management — is graduated awareness and
*presupposes a metric*; continuous earshot falloff genuinely needs distance. We
trade that graduation for determinism: whisper/say/shout are three discrete
tiers, not a curve. And Jupiter (1995) showed mixing continuous media into a
room model "denies the metaphor" — so every channel stays discrete.
[Benford/Fahlén CSCW 1993](https://www.lri.fr/~mbl/ENS/CSCW/2013/papers/Benford_CSCW1993.pdf),
[interest-management comparison](https://www.researchgate.net/publication/221391497_Comparing_interest_management_algorithms_for_massively_multiplayer_games)

**Warning — hotspots are structural.** EVE's per-zone ceiling and the fact that
fixing one hub (Yulai) just moved congestion to another (Jita) means
room-partitioned presence has permanent load imbalance. Matters only if a
fixture crowds one room.

## 3. LLM agent societies

**Vindication — Smallville is coordinate-free too.** Generative Agents
represents its world as a containment tree of areas/objects rendered to natural
language; coordinates are used only for pathing after the model picks a
destination. Same model as Simfile.
[Generative Agents](https://arxiv.org/pdf/2304.03442)

**Warning — self-report is an unreliable diffusion instrument.** Smallville
measured diffusion by interviewing all 25 agents; 1.3% of awareness responses
were confabulated and agents embellished real facts with invented detail. This
is *the* argument for tracing marker content through the ledger instead of
asking agents what they know.
[Generative Agents](https://arxiv.org/pdf/2304.03442)

**Vindication — inject-and-count is the right diffusion method.** Project Sid
measured cultural transmission by injecting Pastafarianism and counting direct
+ indirect converts over time (steady, non-saturating spread). Exactly the
propagation-marker pattern.
[Project Sid](https://arxiv.org/html/2411.00114)

**The scale ceiling, in published numbers.** Generative Agents: 25 agents × 2
days = thousands of dollars, multiple real days. Project Sid: 50–100/society,
500–1000 across societies, and past ~1000 the *world engine* (Minecraft), not
the minds, became the bottleneck. Confirms honest-niche "tens live, low
hundreds with fake engines."
[Generative Agents](https://arxiv.org/pdf/2304.03442),
[Project Sid](https://arxiv.org/html/2411.00114)

**The strongest counter-model — Concordia (closest cousin).** DeepMind's
Concordia resolves the world through a single LLM Game Master interpreting
natural-language actions into outcomes; world state is LLM-mediated,
nondeterministic, non-replayable, and its reliability protocol is statistical
replication, not replay. Simfile is the deliberate inverse: mechanical world,
nondeterministic agents, provenance split. Concordia's world is a mind; ours is
a machine minds talk to. Its documented failure modes — an agent refusing an
assigned misinformation role; cascading hallucination in Project Sid — are ones
a mechanical world structurally cannot have (state is never whatever an agent
hallucinated).
[Concordia](https://github.com/google-deepmind/concordia),
[Concordia paper](https://arxiv.org/pdf/2312.03664),
[AI Town](https://github.com/a16z-infra/ai-town)

## 4. Determinism & replay

**Vindication — deterministic-world/recorded-input is proven at scale.** RTS
lockstep transmits only inputs and recomputes the world identically on every
peer — Age of Empires (shipped to millions), Factorio, Fiedler's demos. This is
exactly "deterministic world + nondeterministic actors recorded as inputs," and
seeded/synchronized PRNGs are established practice.
[1500 archers (AoE)](https://www.gamedeveloper.com/programming/1500-archers-on-a-28-8-network-programming-in-age-of-empires-and-beyond),
[Gaffer deterministic lockstep](https://gafferongames.com/post/deterministic_lockstep/),
[Factorio FFF-188](https://factorio.com/blog/post/fff-188)

**Warning (the big one) — float determinism lives in the transcendentals.**
IEEE 754 conformance does *not* guarantee identical results across
compilers/architectures; sin/cos diverge AMD-vs-Intel; FMA and x87 intermediates
break even `(a+b)+c`. Our `eq` grammar has `sin`/`cos`/`exp`, so the evaluator
must ship its own fixed transcendental implementations (or prove fixed-precision
rounding absorbs the divergence) — never `libm`. This is the single most likely
determinism break.
[Gaffer float determinism](https://gafferongames.com/post/floating_point_determinism/),
[randomascii](https://randomascii.wordpress.com/2013/07/16/floating-point-determinism/)

**Adopt — Factorio's testing techniques.** "Heavy mode" (serialize/reload every
tick to force hidden state to surface) → make serialize round-trip a tested
kernel invariant. Desync reports (diff two full states to localize divergence)
→ the model for debugging a broken replay.
[Factorio desync](https://wiki.factorio.com/Desynchronization)

## 5. Measurement / probes

**Vindication — `when/expect` is a known, efficiently-monitorable fragment.**
Bounded MTL / past-MTL admits trace-length-independent online monitoring: a
sliding window over the event stream, cost independent of ledger length, live
and post-hoc from one spec. Our `after`/`within` windows are precisely the
bounded operators this theory covers.
[Reelay/Mamouras](https://kmamouras.github.io/papers/monitoring-RV),
[Havelund et al. RV14](https://people.mpi-sws.org/~joel/publications/rv14.pdf),
[trace-length-independent MTL](https://dl.acm.org/doi/10.1145/2535417)

**Adopt — three inherited lessons.** (1) Bounded operators are the right
restriction: unbounded future modalities can't be monitored in bounded memory,
so `within:` is a feature. (2) Space-bounded monitoring needs a max
events-per-interval — the per-tick event fuse already supplies it. (3) Monitors
are bug-prone (a Coq-verified oracle found bugs in Reelay) — the probe evaluator
needs differential/oracle testing.

**Deferred — quantitative robustness semantics.** Grading *how close* a run came
to violating a claim subsumes binary pass/fail and is valuable for tuning. Binary
stays the v0 contract.

**Caution — attribution is a statistical artefact.** Epidemiology transmission-
tree work: crediting spread to a specific individual can be an artefact of tree
structure, while superspreader *events* are reproducible. Credit spread to
scopes/paths; treat per-agent attribution as the weaker claim.
[transmission-tree analysis](https://www.medrxiv.org/content/10.1101/2020.12.21.20248673.full.pdf)

---

## 6. Space, objects, possession, belonging & access (second run)

Run 2026-07-07 via a hosted research session
(ChatGPT · Extra High, headed browser); full report with citation anchors in
`research/2026-07-07/space-objects-access.md` (+ `.chatgpt.reply.html`).

**Adopt — affordance-bound micro-position.** "Topology first, sparse
micro-position second" is the convergent pattern (Inform supporters/
enterables and its explicit "do a little, then named positions" advice; Fate
zones; Blades position-as-fiction). At most one optional micro-location per
agent, bound to an affordance (`on`/`in`/`at`/`near`); `in` an enterable
conceals from `here:`. Refusing all sub-room position causes room explosion;
adding coordinates causes space-management overhead. Both named failure
modes.

**Adopt — whisper visible cue.** MUD/MOO practice: bystanders perceive
"X whispers to Y", content-free. Preserves suspicion and eavesdropping
opportunity without leaking content (Cobot in LambdaMOO whispered partly to
avoid public spam).

**Vindication + counterargument — discrete tiers won for text.** Say/whisper/
yell ladders everywhere (GemStone SAY/WHISPER/YELL, MOOSE Crossing, Second
Life whisper 10m/say 20m/shout 100m); graduated falloff won only for voice
(Gather, proximity mods). The honest counter: shipped shouts carry *content*
to adjacent rooms; muffled-only adjacency risks agents routing around it.
Answer recorded in DESIGN: ungated chat rooms are the legitimate long-range
primitive; carry shout content one hop only if fixtures show defection.

**Adopt — title as a document layer.** The strongest objection to
custody-without-title (Koster's ownership law; UO/EVE re-inventing title via
insured/blessed/stolen flags and reimbursement carve-outs) is answered by
world-native claim documents — deeds, charters, receipts, police reports —
as entities-with-props or org docs; kernel ignores them except where access
profiles reference them.

**Adopt — access on doors/containers/places, never per-item ACLs.** The
unanimous shipped granularity (Inform lock+matching-key, UO house roles and
secures, FFXIV estate rightsholders/tenants/blacklists, Second Life parcel
allow/ban/group). Belonging = charter naming steward + delegates; place
access profile `public|invite|group|banned`; keys via `has:`; trespass
ledgered.

**Adopt — enforcement rung per place.** UO's Trammel/Felucca is the canonical
natural experiment: hard prevention doubled subscribers and flattened
emergence ("a lot of magical stuff stopped happening" — Koster); EVE's
scams-are-legal stance still ring-fences rookies. Both extremes fail; homes
default policy-rung, commons default moral-rung, districts can differ.

**Gaps the report flagged honestly:** no clean primary source found for
LambdaMOO yell semantics, UO's old stolen-flag/fencing rules, or a
first-party DragonRealms YELL page — treat those specific mechanics as
folklore-grade until verified.

---

## Provenance

Raw run: local research harness, 2026-07-07, ~24 sources mined for falsifiable
claims across the five pillars. This file is the synthesized, human-checked
digest; source URLs above are the primary references and should be re-verified
before any claim is treated as load-bearing beyond design rationale.
