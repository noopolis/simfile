import { RUN_PAGE_SCRIPT } from "./runPageScript.js";
import { RUN_PAGE_STYLES } from "./runPageStyles.js";
import type { RunViewModel } from "./runViewModelTypes.js";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);

/**
 * JSON-serializes the view-model for inlining into a `<script>` tag, closing
 * off the `</script` sequence so a message or memory row containing that
 * literal text cannot break out of the tag.
 */
const embedJson = (value: unknown): string => JSON.stringify(value).replace(/<\/script/giu, "<\\/script");

/**
 * Renders the dedicated run-reader page for `simfile view <run-dir>` when
 * the directory is a compose-and-observe run (`runDetect.ts`). A lightweight
 * self-contained page rather than the React/GlyphCSS world viewer: this
 * mode has no place-bearing world, no 3D map, nothing GlyphCSS earns its
 * keep rendering — it is a conversation, its causal trace, and a set of
 * memory portals, which is exactly what `VIEW_DESIGN.md`'s "placeless scopes
 * open as portals" rule already treats as plain HTML.
 */
export const renderRunPage = (model: RunViewModel): string => {
  const worldLabel = model.world?.networkId && model.world.roomId
    ? `${model.world.networkId} / ${model.world.roomId}`
    : undefined;

  const runMeta = [
    `<span><b>run</b> <span class="mono">${escapeHtml(model.runId)}</span></span>`,
    `<span><b>recorded</b> ${escapeHtml(model.createdAt)}</span>`,
    model.engine ? `<span><b>engine</b> <span class="mono">${escapeHtml(model.engine)}</span></span>` : "",
    worldLabel ? `<span><b>world</b> ${escapeHtml(worldLabel)}</span>` : ""
  ].filter(Boolean).join("\n      ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Run Record · ${escapeHtml(model.runId)} · Simfile</title>
<style>${RUN_PAGE_STYLES}</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="eyebrow">Simfile · Run Record · Replay</div>
    <h1>Run ${escapeHtml(model.runId)}</h1>
    <div class="runmeta">
      ${runMeta}
    </div>
    <div class="verdict" id="verdict"></div>
  </header>

  <section>
    <div class="sechead"><h2>The Room</h2><span class="note">Moltnet room traffic · @mentions drive who wakes next</span></div>
    <div class="thread" id="thread"></div>
  </section>

  <section>
    <div class="sechead"><h2>The Minds</h2><span class="note">Each agent's memory bank — a portal into what it took in, said, and recalled</span></div>
    <div class="minds" id="minds"></div>
  </section>

  <section>
    <div class="sechead"><h2>Provenance</h2><span class="note">Every element above traces to one of these records</span></div>
    <div class="prov">
      <div class="provgrid">
        <div>
          <div class="eyebrow" style="color:var(--dim)">Artifacts · SHA-256 verified</div>
          <div class="artlist" id="artlist"></div>
        </div>
        <div>
          <div class="eyebrow" style="color:var(--dim)">Reconciliation</div>
          <div class="kv" id="kv"></div>
        </div>
      </div>
    </div>
    <p class="foot">
      <b>Observer-tier replay.</b> Rendered read-only from the sealed run directory's
      <span class="mono">manifest.json</span>, <span class="mono">raw/moltnet/transcript.json</span>,
      and <span class="mono">raw/daimon/</span> / <span class="mono">raw/mneme/</span> causal streams,
      reconciled by <span class="mono">simfile observe</span> into the
      <span class="mono">${escapeHtml(model.provenance.entries.find((entry) => entry.key === "contract")?.value ?? "simfile.observe.v1")}</span>
      report. No decorative state: every chip above is a real ledger event id.
    </p>
  </section>
</div>

<script>window.__RUN_VIEW_MODEL__ = ${embedJson(model)};</script>
<script>${RUN_PAGE_SCRIPT}</script>
</body>
</html>
`;
};
