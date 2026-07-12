/**
 * The run-reader page's CSS — ported from the approved reference design
 * (a static mockup of this exact view) and generalized: agent colors come
 * from a fixed 6-entry accent palette (`--acc0`..`--acc5`) assigned by
 * participant order instead of hardcoded names, so any run's participant
 * list renders without a new stylesheet.
 */
export const RUN_PAGE_STYLES = `
:root {
  --bg: #f4f5fa; --panel: #ffffff; --panel-2: #eef0f7; --line: #dde1ec;
  --ink: #171922; --dim: #575d72; --faint: #949ab2;
  --trace: #159b91; --trace-soft: #159b9122;
  --human: #5c6376; --human-soft: #5c637614;
  --good: #1a9e75; --good-soft: #1a9e7518;
  --acc0: #6f5fe0; --acc0-soft: #6f5fe019;
  --acc1: #b9781f; --acc1-soft: #b9781f16;
  --acc2: #1f8fb9; --acc2-soft: #1f8fb916;
  --acc3: #b91f6e; --acc3-soft: #b91f6e16;
  --acc4: #4f9d3d; --acc4-soft: #4f9d3d16;
  --acc5: #9d4f3d; --acc5-soft: #9d4f3d16;
  --shadow: 0 1px 2px rgba(20,24,40,.05), 0 8px 24px rgba(20,24,40,.06);
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Code", Menlo, monospace;
  --sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0b0c13; --panel: #13141d; --panel-2: #191b26; --line: #272b3b;
    --ink: #e7e9f3; --dim: #969cb2; --faint: #5b6178;
    --trace: #3ad0c5; --trace-soft: #3ad0c520;
    --human: #8890a6; --human-soft: #8890a615;
    --good: #47cfa0; --good-soft: #47cfa01c;
    --acc0: #9d90ff; --acc0-soft: #9d90ff1c;
    --acc1: #e6ab5b; --acc1-soft: #e6ab5b18;
    --acc2: #5bc6e6; --acc2-soft: #5bc6e618;
    --acc3: #e65ba3; --acc3-soft: #e65ba318;
    --acc4: #7bd45f; --acc4-soft: #7bd45f18;
    --acc5: #d4805f; --acc5-soft: #d4805f18;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 10px 30px rgba(0,0,0,.35);
  }
}
:root[data-theme="light"] {
  --bg: #f4f5fa; --panel: #ffffff; --panel-2: #eef0f7; --line: #dde1ec;
  --ink: #171922; --dim: #575d72; --faint: #949ab2;
  --trace: #159b91; --trace-soft: #159b9122;
  --human: #5c6376; --human-soft: #5c637614;
  --good: #1a9e75; --good-soft: #1a9e7518;
}
:root[data-theme="dark"] {
  --bg: #0b0c13; --panel: #13141d; --panel-2: #191b26; --line: #272b3b;
  --ink: #e7e9f3; --dim: #969cb2; --faint: #5b6178;
  --trace: #3ad0c5; --trace-soft: #3ad0c520;
  --human: #8890a6; --human-soft: #8890a615;
  --good: #47cfa0; --good-soft: #47cfa01c;
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font-family: var(--sans); line-height: 1.55;
  -webkit-font-smoothing: antialiased; letter-spacing: -0.005em;
}
.wrap { max-width: 1140px; margin: 0 auto; padding: clamp(20px, 4vw, 52px) clamp(16px, 4vw, 40px) 80px; }
.mono { font-family: var(--mono); }
.eyebrow {
  font-size: 11px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--faint); font-family: var(--mono);
}
h1 { font-size: clamp(24px, 4vw, 34px); line-height: 1.1; margin: 12px 0 0; letter-spacing: -0.03em; font-weight: 650; }
h2 { font-size: 13px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dim); margin: 0; font-family: var(--mono); }

header { border-bottom: 1px solid var(--line); padding-bottom: 26px; }
.runmeta { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 20px; font-size: 13px; color: var(--dim); }
.runmeta b { color: var(--ink); font-weight: 550; }
.runmeta .mono { font-size: 12.5px; }
.verdict { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 22px; }
.pill {
  display: inline-flex; align-items: baseline; gap: 8px; padding: 9px 14px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow);
  font-size: 12px; color: var(--dim);
}
.pill .n { font-size: 18px; font-weight: 650; color: var(--ink); font-family: var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.pill.status { border-color: color-mix(in srgb, var(--good) 45%, var(--line)); background: var(--good-soft); }
.pill.status.unhealthy { border-color: color-mix(in srgb, #c0392b 45%, var(--line)); background: #c0392b18; }
.pill.status .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); align-self: center; box-shadow: 0 0 0 3px var(--good-soft); }
.pill.status.unhealthy .dot { background: #c0392b; box-shadow: 0 0 0 3px #c0392b18; }
.pill.status .n { color: var(--good); font-size: 13px; font-weight: 650; letter-spacing: 0.04em; text-transform: uppercase; }
.pill.status.unhealthy .n { color: #c0392b; }

section { margin-top: 46px; }
.sechead { display: flex; align-items: baseline; gap: 14px; margin-bottom: 20px; }
.sechead .note { font-size: 12.5px; color: var(--faint); }

.thread { display: flex; flex-direction: column; gap: 14px; }
.msg { display: grid; grid-template-columns: 132px 1fr; gap: 18px; align-items: start; }
@media (max-width: 620px) { .msg { grid-template-columns: 1fr; gap: 8px; } }
.who { display: flex; flex-direction: column; gap: 4px; padding-top: 3px; }
.avatar { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
.glyph { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; font-family: var(--mono); font-size: 13px; font-weight: 700; color: #fff; flex: none; }
.role { font-size: 11px; color: var(--faint); font-family: var(--mono); letter-spacing: 0.04em; padding-left: 34px; }
.role.top { padding-left: 0; }
.bubble { background: var(--panel); border: 1px solid var(--line); border-radius: 4px 14px 14px 14px; padding: 14px 16px 13px; box-shadow: var(--shadow); position: relative; }
.msg.human .bubble { border-left: 2.5px solid var(--human); background: var(--panel-2); border-style: dashed; }
.turnno { font-family: var(--mono); font-size: 11px; color: var(--faint); }
.btext { font-size: 15.5px; margin: 3px 0 0; letter-spacing: -0.01em; white-space: pre-wrap; }
.btext .at { font-weight: 600; padding: 0 2px; border-radius: 4px; }
.time { font-size: 11px; color: var(--faint); font-family: var(--mono); float: right; margin-left: 10px; }

.trace { margin-top: 12px; border-top: 1px dashed var(--line); padding-top: 11px; }
.traceflow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px;
  padding: 4px 9px; border-radius: 7px; background: var(--panel-2); border: 1px solid var(--line); color: var(--dim);
  white-space: nowrap;
}
.chip .k { color: var(--faint); }
.chip.trc { color: var(--trace); border-color: color-mix(in srgb, var(--trace) 40%, var(--line)); background: var(--trace-soft); }
.chip.mem { color: var(--good); border-color: color-mix(in srgb, var(--good) 38%, var(--line)); background: var(--good-soft); }
.arrow { color: var(--faint); font-size: 12px; }
.recallflag {
  margin-top: 9px; display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--ink);
  background: var(--acc0-soft); border: 1px solid color-mix(in srgb, var(--acc0) 30%, var(--line));
  border-radius: 9px; padding: 9px 12px;
}
.recallflag .ic { color: var(--acc0); font-size: 15px; }
.recallflag b { font-weight: 600; }
details.detail { margin-top: 10px; }
details.detail > summary { cursor: pointer; font-size: 11.5px; color: var(--trace); font-family: var(--mono); list-style: none; display: inline-flex; align-items: center; gap: 6px; user-select: none; }
details.detail > summary::-webkit-details-marker { display: none; }
details.detail > summary::before { content: "▸"; font-size: 9px; transition: transform .15s ease; }
details.detail[open] > summary::before { transform: rotate(90deg); }
.records { margin-top: 10px; display: flex; flex-direction: column; gap: 5px; padding-left: 4px; }
.rec { display: grid; grid-template-columns: 116px 1fr; gap: 10px; font-family: var(--mono); font-size: 11px; align-items: baseline; }
.rec .kind { color: var(--faint); text-align: right; }
.rec .id { color: var(--dim); word-break: break-all; }
.rec .id .em { color: var(--trace); }

.minds { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
@media (max-width: 720px) { .minds { grid-template-columns: 1fr; } }
.mind { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px; box-shadow: var(--shadow); }
.mindhead { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.mindhead .name { font-weight: 650; font-size: 16px; }
.mindhead .count { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--faint); }
.strata { display: flex; flex-direction: column; gap: 9px; }
.stratum { display: grid; grid-template-columns: 82px 1fr; gap: 12px; align-items: start; }
.slabel { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; padding-top: 2px; }
.slabel.claimed { color: var(--human); }
.slabel.observed { color: var(--dim); }
.slabel.recalled { color: var(--acc0); }
.mrows { display: flex; flex-direction: column; gap: 6px; }
.mrow { font-size: 13px; color: var(--ink); border-left: 2px solid var(--line); padding: 1px 0 1px 10px; }
.mrow.recalled { border-left-color: var(--acc0); }
.mrow small { color: var(--faint); font-family: var(--mono); font-size: 10.5px; }

.prov { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px 22px; box-shadow: var(--shadow); }
.provgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px 34px; }
@media (max-width: 720px) { .provgrid { grid-template-columns: 1fr; } }
.artlist { display: flex; flex-direction: column; gap: 7px; margin-top: 12px; }
.art { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: baseline; font-family: var(--mono); font-size: 11.5px; }
.art .p { color: var(--dim); }
.art .h { color: var(--faint); display: inline-flex; align-items: center; gap: 7px; }
.art .h .ok { color: var(--good); }
.art .h .bad { color: #c0392b; }
.kv { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; font-size: 12.5px; }
.kv .row { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dotted var(--line); padding-bottom: 6px; }
.kv .row span:first-child { color: var(--dim); }
.kv .row span:last-child { font-family: var(--mono); color: var(--ink); }

.foot { margin-top: 34px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--faint); font-size: 12.5px; max-width: 72ch; }
.foot b { color: var(--dim); font-weight: 600; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;
