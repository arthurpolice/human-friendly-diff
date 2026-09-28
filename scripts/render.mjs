#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const ANALYSIS_SCHEMA = "human-friendly-diff.analysis/v2";
const MAX_REPORT_BYTES = 25 * 1024 * 1024;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function formatBytes(value) {
  if (value == null) return "unknown size";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeAnalysis(capture, input) {
  const hunkMap = new Map();
  for (const file of capture.files) {
    for (const hunk of file.hunks) hunkMap.set(hunk.id, { file, hunk });
  }
  const validIds = (values) => [...new Set((Array.isArray(values) ? values : []).map(String).filter((id) => hunkMap.has(id)))];
  const primaryModules = new Set();
  const modules = [];
  for (const [index, raw] of (Array.isArray(input?.overview?.modules) ? input.overview.modules : []).entries()) {
    if (!raw || typeof raw !== "object") continue;
    const hunkIds = validIds(raw.hunkIds).filter((id) => !primaryModules.has(id));
    hunkIds.forEach((id) => primaryModules.add(id));
    modules.push({
      id: slug(raw.id || raw.name || `module-${index + 1}`) || `module-${index + 1}`,
      name: String(raw.name || `Module ${index + 1}`),
      summary: String(raw.summary || "No module summary was supplied."),
      hunkIds,
      secondaryHunkIds: validIds(raw.secondaryHunkIds),
    });
  }
  const moduleRemainder = [...hunkMap.keys()].filter((id) => !primaryModules.has(id));
  if (moduleRemainder.length || modules.length === 0) {
    modules.push({
      id: "supporting",
      name: modules.length ? "Supporting changes" : "Unclassified module",
      summary: "Changes without a confident functional-module assignment.",
      hunkIds: moduleRemainder.length ? moduleRemainder : [...hunkMap.keys()],
      secondaryHunkIds: [],
    });
  }

  const referenced = new Set();
  const stories = [];
  for (const [storyIndex, raw] of (Array.isArray(input?.stories) ? input.stories : []).entries()) {
    if (!raw || typeof raw !== "object") continue;
    const steps = [];
    for (const [stepIndex, step] of (Array.isArray(raw.steps) ? raw.steps : []).entries()) {
      if (!step || typeof step !== "object") continue;
      const excerpts = [];
      for (const excerpt of Array.isArray(step.excerpts) ? step.excerpts : []) {
        const hunkId = String(excerpt?.hunkId || "");
        if (!hunkMap.has(hunkId)) continue;
        const lineCount = hunkMap.get(hunkId).hunk.lines.length;
        const lineStart = Math.max(1, Math.min(lineCount || 1, Number(excerpt.lineStart) || 1));
        const lineEnd = Math.max(lineStart, Math.min(lineCount || lineStart, Number(excerpt.lineEnd) || lineCount || lineStart));
        excerpts.push({ hunkId, lineStart, lineEnd, explanation: String(excerpt.explanation || "") });
        referenced.add(hunkId);
      }
      if (excerpts.length === 0) continue;
      steps.push({
        id: slug(step.id || `beat-${stepIndex + 1}`) || `beat-${stepIndex + 1}`,
        actor: String(step.actor || "System"),
        action: String(step.action || "Applies the captured change"),
        outcome: String(step.outcome || "The next behavior becomes possible."),
        moduleId: slug(step.moduleId || "supporting") || "supporting",
        excerpts,
      });
    }
    if (steps.length === 0) continue;
    const storyHunks = new Set(steps.flatMap((step) => step.excerpts.map((excerpt) => excerpt.hunkId)));
    let attention = ["routine", "review-carefully", "critical"].includes(raw.attention) ? raw.attention : "routine";
    const confidence = ["high", "medium", "low"].includes(raw.confidence) ? raw.confidence : "medium";
    const severe = [...storyHunks].some((id) => {
      const { file, hunk } = hunkMap.get(id);
      return file.status === "conflicted" || hunk.secretFindings.length > 0;
    });
    if (severe) attention = "critical";
    else if (confidence === "low" && attention === "routine") attention = "review-carefully";
    stories.push({
      id: slug(raw.id || raw.title || `story-${storyIndex + 1}`) || `story-${storyIndex + 1}`,
      title: String(raw.title || `System story ${storyIndex + 1}`),
      goal: String(raw.goal || "Explain how this change moves through the system."),
      summary: String(raw.summary || ""),
      attention,
      attentionReason: String(raw.attentionReason || (severe ? "Deterministic checks found a critical review signal." : "")),
      confidence,
      risks: Array.isArray(raw.risks) ? raw.risks.map(String) : [],
      questions: Array.isArray(raw.questions) ? raw.questions.map(String) : [],
      steps,
    });
  }

  const uncovered = [...hunkMap.keys()].filter((id) => !referenced.has(id));
  if (uncovered.length) {
    stories.push({
      id: "supporting-changes",
      title: "Supporting changes",
      goal: "Keep every captured change reachable for review.",
      summary: "These hunks were not assigned to a semantic system story.",
      attention: uncovered.some((id) => {
        const { file, hunk } = hunkMap.get(id);
        return file.status === "conflicted" || hunk.secretFindings.length > 0;
      }) ? "critical" : "review-carefully",
      attentionReason: "Story coverage was incomplete or ambiguous.",
      confidence: "low",
      risks: [],
      questions: ["Which system story should own these changes?"],
      steps: uncovered.map((hunkId, index) => ({
        id: `unclassified-${index + 1}`,
        actor: "Supporting code",
        action: "Changes outside the inferred narrative",
        outcome: "The complete Git snapshot remains reviewable.",
        moduleId: modules.find((module) => module.hunkIds.includes(hunkId))?.id || "supporting",
        excerpts: [{ hunkId, lineStart: 1, lineEnd: hunkMap.get(hunkId).hunk.lines.length || 1, explanation: "Unclassified captured hunk." }],
      })),
    });
  }

  return {
    schemaVersion: ANALYSIS_SCHEMA,
    sourceSchemaVersion: input?.schemaVersion || null,
    overview: { modules },
    verification: Array.isArray(input?.verification) ? input.verification.map((item) => ({
      command: String(item?.command || "Unknown command"),
      status: ["passed", "failed", "not-run"].includes(item?.status) ? item.status : "not-run",
      note: String(item?.note || ""),
    })) : [],
    stories,
  };
}

const CODE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb", ".go", ".rs", ".java",
  ".kt", ".swift", ".php", ".cs", ".css", ".scss", ".html", ".vue", ".svelte", ".sh",
  ".bash", ".zsh", ".json", ".yaml", ".yml", ".toml",
]);

function highlightCode(text, path) {
  if (!CODE_EXTENSIONS.has(extname(path).toLowerCase())) return escapeHtml(text);
  const pattern =
    /(\/\/.*$|#.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:true|false|null|undefined|const|let|var|function|class|return|if|else|for|while|import|export|from|async|await|new|throw|try|catch|interface|type|public|private|def|end|do|fn|struct|enum|match|impl|use|package)\b|\b\d+(?:\.\d+)?\b)/gm;
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    output += escapeHtml(text.slice(cursor, match.index));
    const token = match[0];
    const kind = /^(?:\/\/|#|\/\*)/.test(token)
      ? "comment"
      : /^["'`]/.test(token)
        ? "string"
        : /^\d/.test(token)
          ? "number"
          : /^(?:true|false|null|undefined)$/.test(token)
            ? "literal"
            : "keyword";
    output += `<span class="tok-${kind}">${escapeHtml(token)}</span>`;
    cursor = match.index + token.length;
  }
  return output + escapeHtml(text.slice(cursor));
}

function lineRow(line, path, extra) {
  const marker = line.kind === "add" ? "+" : line.kind === "delete" ? "−" : line.kind === "meta" ? "·" : " ";
  return `<tr class="diff-line ${line.kind}${extra ? " extra-context" : ""}">
    <td class="ln old">${line.oldLine ?? ""}</td>
    <td class="ln new">${line.newLine ?? ""}</td>
    <td class="marker">${marker}</td>
    <td class="code"><code>${highlightCode(line.text, path)}</code></td>
  </tr>`;
}

function sideRows(lines, path, extraFlags) {
  const rows = [];
  let index = 0;
  while (index < lines.length) {
    const current = lines[index];
    if (current.kind === "delete") {
      const deletes = [];
      const adds = [];
      while (index < lines.length && lines[index].kind === "delete") {
        deletes.push({ line: lines[index], extra: extraFlags[index] });
        index += 1;
      }
      while (index < lines.length && lines[index].kind === "add") {
        adds.push({ line: lines[index], extra: extraFlags[index] });
        index += 1;
      }
      const count = Math.max(deletes.length, adds.length);
      for (let pairIndex = 0; pairIndex < count; pairIndex += 1) {
        const left = deletes[pairIndex];
        const right = adds[pairIndex];
        const extra = Boolean(left?.extra || right?.extra);
        rows.push(`<tr class="side-line${extra ? " extra-context" : ""}">
          <td class="ln old">${left?.line.oldLine ?? ""}</td>
          <td class="code delete"><code>${left ? highlightCode(left.line.text, path) : ""}</code></td>
          <td class="ln new">${right?.line.newLine ?? ""}</td>
          <td class="code add"><code>${right ? highlightCode(right.line.text, path) : ""}</code></td>
        </tr>`);
      }
      continue;
    }
    if (current.kind === "add") {
      rows.push(`<tr class="side-line${extraFlags[index] ? " extra-context" : ""}">
        <td class="ln old"></td><td class="code"></td>
        <td class="ln new">${current.newLine ?? ""}</td>
        <td class="code add"><code>${highlightCode(current.text, path)}</code></td>
      </tr>`);
    } else {
      rows.push(`<tr class="side-line${extraFlags[index] ? " extra-context" : ""}">
        <td class="ln old">${current.oldLine ?? ""}</td>
        <td class="code context"><code>${highlightCode(current.text, path)}</code></td>
        <td class="ln new">${current.newLine ?? ""}</td>
        <td class="code context"><code>${highlightCode(current.text, path)}</code></td>
      </tr>`);
    }
    index += 1;
  }
  return rows.join("");
}

function excerptMarkup(entry, excerpt, instance, forceCompact) {
  const { file, hunk } = entry;
  const selected = hunk.lines.slice(excerpt.lineStart - 1, excerpt.lineEnd);
  const lines = selected.length ? selected : hunk.lines;
  const flags = lines.map(() => false);
  const snapshot = file.snapshots || {};
  const snapshots = forceCompact ? "" : [
    snapshot.before?.available ? `<section><h5>Before · HEAD</h5><pre>${escapeHtml(snapshot.before.text)}</pre></section>` : "",
    snapshot.after?.available ? `<section><h5>After · current branch</h5><pre>${escapeHtml(snapshot.after.text)}</pre></section>` : "",
  ].filter(Boolean).join("");
  const contextReason = snapshots ? "" : `<p class="context-note">${forceCompact ? "Full-file context omitted to keep this report below 25 MB." : `Full-file context unavailable (${escapeHtml(snapshot.after?.reason || snapshot.before?.reason || "not captured")}).`}</p>`;
  const secret = hunk.secretFindings.length
    ? `<div class="signal critical-signal">Potential secret pattern detected on added line${hunk.secretFindings.length === 1 ? "" : "s"} ${hunk.secretFindings.map((finding) => finding.newLine).join(", ")}.</div>`
    : "";
  return `<article class="excerpt" id="excerpt-${escapeHtml(instance)}" data-hunk-anchor="${escapeHtml(slug(hunk.id))}">
    <header class="excerpt-head"><div><a href="#excerpt-${escapeHtml(instance)}">${escapeHtml(file.oldPath !== file.newPath ? `${file.oldPath} → ${file.newPath}` : file.path)}</a><span>${escapeHtml(file.stageState)}</span><span>${escapeHtml(file.changeKind || "other")}</span></div><small>lines ${excerpt.lineStart}–${excerpt.lineEnd} of hunk</small></header>
    <p class="excerpt-why"><b>Why here</b>${escapeHtml(excerpt.explanation || "This excerpt supports the current story beat.")}</p>
    ${secret}${file.status === "conflicted" ? '<div class="signal critical-signal">Unresolved merge conflict.</div>' : ""}
    ${file.isBinary || hunk.metadataOnly ? `<div class="binary">${escapeHtml(hunk.header)}</div>` : `<div class="hunk-label">${escapeHtml(hunk.header)}</div><div class="diff unified-view"><table><tbody>${lines.map((line) => lineRow(line, file.path, false)).join("")}</tbody></table></div><div class="diff side-view" hidden><table><tbody>${sideRows(lines, file.path, flags)}</tbody></table></div>`}
    ${snapshots ? `<details class="file-context"><summary>Expand full file context</summary><div class="snapshot-grid">${snapshots}</div></details>` : contextReason}
  </article>`;
}

function buildHtml(capture, analysis, forceCompact = false) {
  const hunkMap = new Map();
  for (const file of capture.files) for (const hunk of file.hunks) hunkMap.set(hunk.id, { file, hunk });
  const lineStats = capture.stats.changeLines || {
    production: { total: capture.stats.additions + capture.stats.deletions },
    test: { total: 0 },
    other: { total: 0 },
  };
  const moduleCards = analysis.overview.modules.map((module) => {
    const ids = [...new Set([...module.hunkIds, ...module.secondaryHunkIds])];
    const files = new Set(ids.map((id) => hunkMap.get(id)?.file.path).filter(Boolean));
    const lines = ids.reduce((total, id) => total + (hunkMap.get(id)?.hunk.lines.filter((line) => line.kind === "add" || line.kind === "delete").length || 0), 0);
    return `<article class="module-card"><span>${files.size} files · ${lines} changed lines</span><h3>${escapeHtml(module.name)}</h3><p>${escapeHtml(module.summary)}</p></article>`;
  }).join("");
  const verification = analysis.verification.length
    ? analysis.verification.map((item) => `<li><span class="verify ${item.status}">${escapeHtml(item.status)}</span><code>${escapeHtml(item.command)}</code>${item.note ? ` — ${escapeHtml(item.note)}` : ""}</li>`).join("")
    : '<li><span class="verify not-run">not reported</span>No verification results were supplied.</li>';
  const slides = [];
  const targetLabel = capture.repository.target ? `${capture.repository.target.ref} @ ${capture.repository.target.mergeBase}` : "target branch unavailable";
  slides.push(`<section class="slide overview-slide" id="overview" data-title="Change overview"><div class="slide-inner"><header class="deck-title"><div class="eyebrow">Branch comparison presentation</div><h1>${escapeHtml(capture.repository.name)}<br><span>${escapeHtml(capture.repository.branch)}</span></h1><p>${escapeHtml(targetLabel)} → HEAD ${escapeHtml(capture.repository.head)} · snapshot ${escapeHtml(capture.repository.fingerprint.slice(0, 12))}</p></header><div class="overview-grid"><section class="loc-panel"><div class="section-label">Change-line composition</div><h2>Production vs tests</h2><div class="loc-bars"><div class="loc-row production"><strong>${lineStats.production.total}</strong><span>Production</span><i style="--size:${lineStats.production.total}"></i></div><div class="loc-row test"><strong>${lineStats.test.total}</strong><span>Tests</span><i style="--size:${lineStats.test.total}"></i></div><div class="loc-row other"><strong>${lineStats.other.total}</strong><span>Other</span><i style="--size:${lineStats.other.total}"></i></div></div><p class="fine-print">Additions + deletions · deterministic path classification</p></section><section class="module-panel"><div class="section-label">Functional map</div><h2>Modules touched</h2><div class="module-list">${moduleCards}</div></section></div></div></section>`);
  let excerptIndex = 0;
  analysis.stories.forEach((story, storyIndex) => {
    story.steps.forEach((step, stepIndex) => {
      const timeline = story.steps.map((item, index) => `<a class="timeline-beat${index === stepIndex ? " active" : ""}" href="#story-${escapeHtml(story.id)}-${index + 1}" title="${escapeHtml(item.action)}"><b>${index + 1}</b><span>${escapeHtml(item.actor)}</span></a>`).join("");
      const excerpts = step.excerpts.map((excerpt) => {
        excerptIndex += 1;
        return excerptMarkup(hunkMap.get(excerpt.hunkId), excerpt, `${story.id}-${step.id}-${excerptIndex}`, forceCompact);
      }).join("");
      const notes = stepIndex === 0 && (story.risks.length || story.questions.length) ? `<aside class="story-notes">${story.risks.length ? `<div><b>Review attention</b>${story.risks.map((risk) => `<p>${escapeHtml(risk)}</p>`).join("")}</div>` : ""}${story.questions.length ? `<div><b>Questions</b>${story.questions.map((question) => `<p>${escapeHtml(question)}</p>`).join("")}</div>` : ""}</aside>` : "";
      slides.push(`<section class="slide story-slide" id="story-${escapeHtml(story.id)}-${stepIndex + 1}" data-title="${escapeHtml(story.title)} · ${stepIndex + 1}/${story.steps.length}"><div class="slide-inner"><header class="story-head"><div class="story-meta"><span>Story ${storyIndex + 1}</span><span class="attention ${story.attention}">${story.attention}</span><span>${escapeHtml(step.moduleId)}</span></div><h2>${escapeHtml(story.title)}</h2><p>${escapeHtml(story.goal)}</p><nav class="timeline">${timeline}</nav></header><div class="beat-layout"><aside class="beat-copy"><div class="beat-number">${String(stepIndex + 1).padStart(2, "0")}</div><div class="actor">${escapeHtml(step.actor)}</div><h3>${escapeHtml(step.action)}</h3><p>${escapeHtml(step.outcome)}</p>${notes}</aside><div class="excerpt-stack">${excerpts}</div></div></div></section>`);
    });
  });
  slides.push(`<section class="slide review-slide" id="review-notes" data-title="Review notes"><div class="slide-inner narrow"><div class="section-label">Finish the review</div><h2>Verification and safety signals</h2><ul class="verification-list">${verification}</ul><div class="coverage"><strong>${capture.stats.hunks}</strong><span>captured hunks remain reachable through the story deck</span></div></div></section>`);
  const title = `Human-Friendly Diff — ${capture.repository.name} — ${capture.repository.branch}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{color-scheme:dark;--ink:#f2f4e8;--muted:#929c8d;--bg:#090b0a;--panel:#111510;--panel2:#181d16;--line:#30372d;--acid:#e7ff55;--cyan:#6ee7e0;--red:#ff6b68;--orange:#ffad54;--green:#79dc83;--add:#102a19;--del:#321716}*{box-sizing:border-box}html,body{height:100%;margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 "IBM Plex Sans","Segoe UI",sans-serif}button{font:inherit;color:inherit}.deck{height:100%;overflow-y:auto;scroll-snap-type:y mandatory}.slide{min-height:100%;scroll-snap-align:start;scroll-snap-stop:always;padding:clamp(28px,4vw,64px);background:radial-gradient(circle at 85% 0,#1a2518 0,transparent 32rem),var(--bg)}.slide-inner{width:min(1500px,100%);margin:auto}.deck-title{margin-bottom:32px}.eyebrow,.section-label,.story-meta{color:var(--acid);font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase}.deck-title h1{margin:8px 0;font:800 clamp(42px,6vw,82px)/.92 "Arial Narrow","Roboto Condensed",sans-serif;letter-spacing:-.04em}.deck-title h1 span{color:var(--muted)}.deck-title p,.fine-print{color:var(--muted);font-family:monospace}.overview-grid{display:grid;grid-template-columns:minmax(300px,.75fr) minmax(420px,1.25fr);gap:22px}.loc-panel,.module-panel{border:1px solid var(--line);background:var(--panel);padding:26px}.overview-grid h2,.review-slide h2{margin:5px 0 22px;font-size:30px}.loc-bars{display:grid;gap:18px}.loc-row{display:grid;grid-template-columns:70px 90px 1fr;align-items:center;gap:12px}.loc-row strong{font-size:32px}.loc-row i{height:14px;width:max(4px,min(100%,calc(var(--size) * 2px)));background:var(--green)}.loc-row.test i{background:var(--cyan)}.loc-row.other i{background:var(--orange)}.module-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px}.module-card{padding:15px;border:1px solid var(--line);background:var(--panel2)}.module-card span{color:var(--muted);font:11px monospace}.module-card h3{margin:8px 0 4px}.module-card p{margin:0;color:#c5ccbf}.story-head{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:30px;border-bottom:1px solid var(--line);padding-bottom:18px}.story-meta{display:flex;gap:9px;align-items:center;grid-column:1/-1}.story-head h2{margin:7px 0 0;font-size:clamp(30px,4vw,52px);line-height:1}.story-head>p{margin:8px 0;color:var(--muted)}.attention{padding:3px 7px;border:1px solid;border-radius:999px}.attention.routine{color:var(--green)}.attention.review-carefully{color:var(--orange)}.attention.critical{color:var(--red)}.timeline{grid-column:2;grid-row:2/4;display:flex;align-items:center;gap:5px}.timeline-beat{display:grid;place-items:center;min-width:48px;color:var(--muted);text-decoration:none}.timeline-beat b{display:grid;place-items:center;width:30px;height:30px;border:1px solid var(--line);border-radius:50%}.timeline-beat span{max-width:76px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px}.timeline-beat.active b{background:var(--acid);color:#0a0c0b;border-color:var(--acid)}.beat-layout{display:grid;grid-template-columns:minmax(220px,.34fr) minmax(0,1fr);gap:22px;padding-top:22px}.beat-copy{position:sticky;top:22px;align-self:start}.beat-number{color:#2b3428;font:900 80px/1 monospace}.actor{color:var(--cyan);font-size:12px;font-weight:900;text-transform:uppercase;letter-spacing:.12em}.beat-copy h3{margin:7px 0;font-size:30px;line-height:1.12}.beat-copy>p{color:#bec6b8}.story-notes{margin-top:20px;padding:14px;border-left:2px solid var(--orange);background:#17150f}.story-notes p{margin:4px 0;color:#c7c3b0;font-size:12px}.excerpt-stack{display:grid;gap:14px}.excerpt{min-width:0;border:1px solid var(--line);background:#0d100e}.excerpt-head{display:flex;justify-content:space-between;padding:10px 12px;background:#151a14}.excerpt-head a{color:var(--cyan);font:12px monospace;text-decoration:none}.excerpt-head span{margin-left:7px;padding:2px 5px;border:1px solid var(--line);color:var(--muted);font-size:9px;text-transform:uppercase}.excerpt-head small{color:var(--muted)}.excerpt-why{display:flex;gap:10px;margin:0;padding:9px 12px;color:#c7cec1}.excerpt-why b{color:var(--acid);font-size:9px;text-transform:uppercase;letter-spacing:.1em}.hunk-label{padding:6px 12px;background:#121812;color:#839779;font:11px monospace}.diff{overflow:auto;max-height:48vh}.diff table{width:100%;border-collapse:collapse;font:12px/1.45 monospace}.diff td{padding:0;vertical-align:top}.ln{width:48px;min-width:48px;padding:0 8px!important;background:#101310;color:#596154;text-align:right;border-right:1px solid #242a22}.marker{width:24px;min-width:24px;text-align:center}.code{white-space:pre;padding:0 10px!important}.diff-line.add,.side-line .add{background:var(--add)}.diff-line.delete,.side-line .delete{background:var(--del)}.side-view .code{width:50%;max-width:0;overflow:hidden}.file-context{border-top:1px solid var(--line)}.file-context summary{padding:9px 12px;color:var(--muted);cursor:pointer}.snapshot-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:1px;background:var(--line)}.snapshot-grid section{min-width:0;background:#0b0d0c}.snapshot-grid h5{margin:0;padding:8px 12px;background:#141813}.snapshot-grid pre{max-height:55vh;margin:0;padding:12px;overflow:auto;font:11px/1.45 monospace}.context-note,.binary,.signal{padding:14px}.critical-signal{color:#ffd3d1;background:#391817;border-left:3px solid var(--red)}.controls{position:fixed;z-index:20;right:18px;bottom:18px;display:flex;align-items:center;gap:6px;padding:7px;border:1px solid var(--line);border-radius:8px;background:#0c0f0deb;backdrop-filter:blur(14px)}.controls button{border:1px solid var(--line);background:var(--panel);padding:7px 11px;cursor:pointer}.controls button:hover,.controls button.active{border-color:var(--acid);color:var(--acid)}.progress{position:fixed;z-index:20;left:0;top:0;height:3px;background:var(--acid);transition:width .2s}.counter{min-width:74px;text-align:center;color:var(--muted);font:11px monospace}.review-slide{display:grid;place-items:center}.narrow{width:min(900px,100%)}.verification-list{padding:0;list-style:none}.verification-list li{margin:8px 0;padding:14px;border:1px solid var(--line);background:var(--panel)}.verify{display:inline-block;margin-right:8px;padding:2px 6px;font-size:10px;font-weight:900;text-transform:uppercase}.verify.passed{color:var(--green)}.verify.failed{color:var(--red)}.verify.not-run{color:var(--orange)}.coverage{display:flex;gap:18px;align-items:center;margin-top:28px}.coverage strong{font-size:62px;color:var(--acid)}.coverage span{max-width:360px;color:var(--muted)}.tok-comment{color:#6d7d67}.tok-string{color:#c7db8d}.tok-number,.tok-literal{color:#e7a96b}.tok-keyword{color:#76cfe0}:focus-visible{outline:2px solid var(--acid);outline-offset:2px}@media(max-width:850px){.overview-grid,.beat-layout{grid-template-columns:1fr}.story-head{display:block}.timeline{margin-top:12px;overflow:auto}.beat-copy{position:static}.slide{padding:24px}.diff{max-height:none}}@media print{.deck{height:auto;overflow:visible}.slide{min-height:100vh;break-after:page}.controls,.progress{display:none}.diff{max-height:none}.file-context:not([open]){display:none}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  </style></head><body><div class="progress" id="progress"></div><main class="deck" id="deck">${slides.join("")}</main><div class="controls"><button id="prev" aria-label="Previous slide">←</button><span class="counter" id="counter"></span><button id="next" aria-label="Next slide">→</button><button class="active" data-view="unified">Unified</button><button data-view="side">Side</button></div><script id="analysis-data" type="application/json">${safeJson(analysis)}</script><script>
  const deck=document.querySelector('#deck');const slides=[...document.querySelectorAll('.slide')];let current=0;const counter=document.querySelector('#counter');const progress=document.querySelector('#progress');
  function show(index,behavior='smooth'){current=Math.max(0,Math.min(slides.length-1,index));slides[current].scrollIntoView({behavior,block:'start'});history.replaceState(null,'','#'+slides[current].id);counter.textContent=(current+1)+' / '+slides.length;progress.style.width=((current+1)/slides.length*100)+'%';document.title=slides[current].dataset.title+' — Human-Friendly Diff'}
  const observer=new IntersectionObserver((entries)=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>b.intersectionRatio-a.intersectionRatio)[0];if(!visible)return;current=slides.indexOf(visible.target);counter.textContent=(current+1)+' / '+slides.length;progress.style.width=((current+1)/slides.length*100)+'%'},{root:deck,threshold:[.55]});slides.forEach(slide=>observer.observe(slide));
  document.querySelector('#prev').addEventListener('click',()=>show(current-1));document.querySelector('#next').addEventListener('click',()=>show(current+1));document.addEventListener('keydown',(event)=>{if(event.target.closest('details,button,input,textarea'))return;if(['ArrowRight','ArrowDown','PageDown',' '].includes(event.key)){event.preventDefault();show(current+1)}if(['ArrowLeft','ArrowUp','PageUp'].includes(event.key)){event.preventDefault();show(current-1)}if(event.key==='Home')show(0);if(event.key==='End')show(slides.length-1)});
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-view]').forEach(item=>item.classList.toggle('active',item===button));const side=button.dataset.view==='side';document.querySelectorAll('.unified-view').forEach(item=>item.hidden=side);document.querySelectorAll('.side-view').forEach(item=>item.hidden=!side)}));
  const initial=slides.findIndex(slide=>'#'+slide.id===location.hash);show(initial>=0?initial:0,'auto');
  </script></body></html>`;
}

function cleanupReports(directory, repoName, keepPath) {
  const prefix = `${slug(repoName)}-`;
  const reports = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".html"))
    .map((name) => ({ path: resolve(directory, name), modified: statSync(resolve(directory, name)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  for (const report of reports.slice(10)) {
    if (report.path !== keepPath) unlinkSync(report.path);
  }
}

function launch(path) {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return false;
  const child = execFile(command, [path], { detached: true, stdio: "ignore" });
  child.unref();
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.capture) throw new Error("Missing required --capture <capture.json>");
  const capture = JSON.parse(readFileSync(resolve(String(args.capture)), "utf8"));
  if (capture.clean || capture.stats?.files === 0) {
    process.stdout.write("Working tree is clean. No report generated.\n");
    return;
  }
  let input = {};
  try {
    if (args.analysis) input = JSON.parse(readFileSync(resolve(String(args.analysis)), "utf8"));
  } catch (error) {
    process.stderr.write(`Analysis could not be read; rendering a fallback presentation: ${error.message}\n`);
  }
  const analysis = normalizeAnalysis(capture, input);
  const reportsDirectory = "/tmp/human-friendly-diff/reports";
  mkdirSync(reportsDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = args.output
    ? resolve(String(args.output))
    : resolve(reportsDirectory, `${slug(capture.repository.name)}-${timestamp}.html`);
  mkdirSync(dirname(output), { recursive: true });

  let html = buildHtml(capture, analysis, false);
  if (Buffer.byteLength(html) > MAX_REPORT_BYTES) html = buildHtml(capture, analysis, true);
  writeFileSync(output, html, "utf8");
  cleanupReports(reportsDirectory, capture.repository.name, output);

  let launched = false;
  if (args.open) {
    try {
      launched = launch(output);
    } catch (error) {
      process.stderr.write(`Report generated, but browser launch failed: ${error.message}\n`);
    }
  }
  process.stdout.write(`Generated ${formatBytes(Buffer.byteLength(html))} report: ${output}${launched ? " (browser launch requested)" : ""}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`human-friendly-diff render failed: ${error.message}\n`);
  process.exitCode = 1;
}
