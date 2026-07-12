/**
 * The run-reader page's client-side renderer. Reads `window.__RUN_VIEW_MODEL__`
 * (inlined by `runPage.ts`) and paints the four sections — verdict, thread,
 * minds, provenance — straight off it. No fetching, no invented state: every
 * chip renders an id that already exists somewhere in the model
 * (`VIEW_DESIGN.md` rule 3). Plain script (not a module) so it runs with no
 * build step, matching this folder's "thin server, no bundler" scope.
 */
export const RUN_PAGE_SCRIPT = `
(function () {
  var model = window.__RUN_VIEW_MODEL__;
  var ACCENTS = ["acc0", "acc1", "acc2", "acc3", "acc4", "acc5"];
  var accentByAgent = {};
  (model.participants || []).forEach(function (id, index) {
    accentByAgent[id] = ACCENTS[index % ACCENTS.length];
  });

  var esc = function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  };

  var glyphFor = function (name) { return (name || "?").trim().charAt(0).toUpperCase() || "?"; };
  var accentVar = function (agentId) { return "var(--" + (accentByAgent[agentId] || "human") + ")"; };
  var accentSoftVar = function (agentId) { return "var(--" + (accentByAgent[agentId] || "human") + "-soft)"; };

  // Plain substring replacement (no RegExp): agent ids are matched longest
  // first so one id can never be clobbered mid-replacement by a shorter
  // one that happens to be its prefix.
  var mentionify = function (text) {
    var escaped = esc(text);
    var ids = (model.participants || []).slice().sort(function (a, b) { return b.length - a.length; });
    ids.forEach(function (id) {
      var needle = "@" + id;
      var replacement = '<span class="at" style="color:' + accentVar(id) + ";background:" + accentSoftVar(id) + '">' + needle + "</span>";
      escaped = escaped.split(needle).join(replacement);
    });
    return escaped;
  };

  // ---- verdict ----
  var v = model.verdict;
  var totalChains = v.chainsComplete + v.chainsIncomplete;
  var pills = [
    {
      n: v.healthy ? "Healthy" : "Issues",
      label: v.healthy ? "no failures, no broken chains" : v.failures + " failures, " + v.chainsIncomplete + " incomplete chains",
      status: true,
      unhealthy: !v.healthy
    },
    { n: String(v.turnCount), label: "agent turns" },
    { n: v.chainsComplete + " / " + totalChains, label: "causal chains complete" },
    { n: String(v.memoryEvents), label: "memory events · " + v.memoryRecalls + " recalls" },
    { n: v.artifactsVerified + " / " + v.artifactsTotal, label: "artifacts verified" }
  ];
  document.getElementById("verdict").innerHTML = pills.map(function (p) {
    var statusClass = p.status ? " status" + (p.unhealthy ? " unhealthy" : "") : "";
    return '<div class="pill' + statusClass + '">' +
      (p.status ? '<span class="dot"></span>' : "") +
      '<span class="n">' + esc(p.n) + '</span><span>' + esc(p.label) + "</span></div>";
  }).join("");

  // ---- thread ----
  var chip = function (kind, id, cls) {
    return '<span class="chip ' + (cls || "") + '"><span class="k">' + esc(kind) + "</span> " + esc(id) + "</span>";
  };
  var arrow = '<span class="arrow">→</span>';

  var traceHtml = function (message) {
    var t = message.trace;
    if (!t) return "";

    var flow = [
      chip("in", t.inEventId, "trc"),
      arrow,
      chip("wake", t.wakeEventId || "unresolved", "trc"),
      arrow,
      chip("turn", t.turnOutputEventId || t.turnInputEventId, "trc"),
      arrow,
      chip("reply", "moltnet:" + message.messageId, "trc"),
      arrow,
      chip("memory", t.memoryWrites.length + " written", "mem")
    ].join(" ");

    var recall = t.recalledMemoryEventIds.length > 0
      ? '<div class="recallflag"><span class="ic">⟲</span><span>Before this turn, <b>' + esc(message.agentId) +
        " recalled " + t.recalledMemoryEventIds.length + " memories</b> — the ledger proves it: its " +
        '<span class="mono">turn.input</span> is caused by the message <em>and</em> ' + t.recalledMemoryEventIds.length +
        ' <span class="mono">mneme:</span> recall id(s). The reply was fed by memory, not just the last message.</span></div>'
      : "";

    var causeRow = '<div class="rec"><span class="kind">caused by</span><span class="id">' +
      t.turnInputCauses.map(function (c) {
        return c.indexOf("mneme:") === 0 ? '<span class="em">' + esc(c) + "</span>" : esc(c);
      }).join(" · ") + "</span></div>";

    var memRow = t.memoryWrites.length
      ? '<div class="rec"><span class="kind">memory</span><span class="id">' +
        t.memoryWrites.map(function (w) { return esc(w.stratum) + " " + esc(w.sourceId); }).join(" · ") + "</span></div>"
      : "";

    return '<div class="trace"><div class="traceflow">' + flow + "</div>" + recall +
      '<details class="detail"><summary>trace to records</summary><div class="records">' +
      '<div class="rec"><span class="kind">message.in</span><span class="id">' + esc(t.inEventId) + "</span></div>" +
      '<div class="rec"><span class="kind">wake</span><span class="id">' + esc(t.wakeEventId || "unresolved") + "</span></div>" +
      '<div class="rec"><span class="kind">turn.input</span><span class="id">' + esc(t.turnInputEventId) + "</span></div>" +
      causeRow +
      '<div class="rec"><span class="kind">turn.output</span><span class="id">' + esc(t.turnOutputEventId || "unresolved") + "</span></div>" +
      '<div class="rec"><span class="kind">reply.out</span><span class="id">' + esc("moltnet:" + message.messageId) + "</span></div>" +
      memRow +
      "</div></details></div>";
  };

  document.getElementById("thread").innerHTML = model.thread.map(function (message) {
    var isHuman = !message.agentId;
    var color = isHuman ? "var(--human)" : accentVar(message.agentId);
    var roleTop = message.turn ? "" : " top";
    var roleText = (message.turn ? "turn " + message.turn + " · " : "") + message.role;
    return '<div class="msg' + (isHuman ? " human" : "") + '">' +
      '<div class="who"><span class="avatar"><span class="glyph" style="background:' + color + '">' +
      esc(glyphFor(message.fromName)) + "</span>" + esc(message.fromName) + "</span>" +
      '<span class="role' + roleTop + '">' + esc(roleText) + "</span></div>" +
      '<div class="bubble"><span class="time">' + esc(message.createdAt) + "</span>" +
      '<p class="btext">' + mentionify(message.text) + "</p>" +
      traceHtml(message) +
      "</div></div>";
  }).join("");

  // ---- minds ----
  var strataLabel = { claimed: "took in", observed: "said", recalled: "recalled" };
  document.getElementById("minds").innerHTML = model.minds.map(function (mind) {
    var color = accentVar(mind.agentId);
    var groups = ["claimed", "observed", "recalled"].map(function (stratum) {
      var rows = mind.rows.filter(function (row) { return row.stratum === stratum; });
      if (!rows.length) return "";
      return '<div class="stratum"><span class="slabel ' + stratum + '">' + strataLabel[stratum] + '</span><div class="mrows">' +
        rows.map(function (row) {
          return '<div class="mrow ' + stratum + '">' + esc(row.text.slice(0, 180)) + "<br><small>" + esc(row.sourceId) + "</small></div>";
        }).join("") + "</div></div>";
    }).join("");
    return '<div class="mind"><div class="mindhead"><span class="glyph" style="background:' + color + '">' +
      esc(glyphFor(mind.agentId)) + '</span><span class="name">' + esc(mind.agentId) +
      '</span><span class="count">' + mind.eventCount + ' events</span></div>' +
      '<div class="strata">' + groups + "</div></div>";
  }).join("");

  // ---- provenance ----
  document.getElementById("artlist").innerHTML = model.provenance.artifacts.map(function (artifact) {
    var mark = artifact.ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
    return '<div class="art"><span class="p">' + esc(artifact.path) + '</span><span class="h">' + mark + " " + esc(artifact.sha256.slice(0, 12)) + "…</span></div>";
  }).join("");
  document.getElementById("kv").innerHTML = model.provenance.entries.map(function (entry) {
    return '<div class="row"><span>' + esc(entry.key) + "</span><span>" + esc(entry.value) + "</span></div>";
  }).join("");
})();
`;
