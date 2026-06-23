#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const ANALYSIS_SCHEMA = "human-friendly-diff.analysis/v1";
const MAX_REPORT_BYTES = 25 * 1024 * 1024;
const ATTENTION_ORDER = { critical: 0, "review-carefully": 1, routine: 2 };

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

function isGenerated(path) {
  return (
    /(^|\/)(dist|build|coverage|vendor)\//.test(path) ||
    /(?:^|\/)(?:package-lock|pnpm-lock|yarn\.lock|Cargo\.lock|composer\.lock)$/.test(path) ||
    /\.(?:min\.(?:js|css)|snap|map)$/.test(path)
  );
}

function normalizeAnalysis(capture, input) {
  const hunkMap = new Map();
  for (const file of capture.files) {
    for (const hunk of file.hunks) hunkMap.set(hunk.id, { file, hunk });
  }

  const assigned = new Set();
  const rawGroups = Array.isArray(input?.groups) ? input.groups : [];
  const groups = [];

  for (const [index, raw] of rawGroups.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const hunkIds = [];
    for (const id of Array.isArray(raw.hunkIds) ? raw.hunkIds : []) {
      if (hunkMap.has(id) && !assigned.has(id)) {
        hunkIds.push(id);
        assigned.add(id);
      }
    }
    if (hunkIds.length === 0) continue;

    let attention = ["routine", "review-carefully", "critical"].includes(raw.attention)
      ? raw.attention
      : "review-carefully";
    const confidence = ["high", "medium", "low"].includes(raw.confidence) ? raw.confidence : "medium";
    const severe = hunkIds.some((id) => {
      const { file, hunk } = hunkMap.get(id);
      return file.status === "conflicted" || hunk.secretFindings.length > 0;
    });
    if (severe) attention = "critical";
    else if (confidence === "low" && attention === "routine") attention = "review-carefully";

    groups.push({
      id: slug(raw.id || raw.title || `group-${index + 1}`) || `group-${index + 1}`,
      title: String(raw.title || `Change group ${index + 1}`),
      summary: String(raw.summary || "AI analysis did not provide a group summary."),
      attention,
      attentionReason: String(raw.attentionReason || (severe ? "Deterministic checks found a critical review signal." : "")),
      confidence,
      hunkIds,
      crossReferences: Array.isArray(raw.crossReferences) ? raw.crossReferences.map(String) : [],
      reviewAfter: Array.isArray(raw.reviewAfter) ? raw.reviewAfter.map(String) : [],
      risks: Array.isArray(raw.risks) ? raw.risks.map(String) : [],
      questions: Array.isArray(raw.questions) ? raw.questions.map(String) : [],
      hunkExplanations: raw.hunkExplanations && typeof raw.hunkExplanations === "object" ? raw.hunkExplanations : {},
    });
  }

  const unassigned = [...hunkMap.keys()].filter((id) => !assigned.has(id));
  if (unassigned.length > 0) {
    groups.push({
      id: "needs-classification",
      title: "Needs classification",
      summary: "These hunks were not confidently assigned by the AI analysis.",
      attention: unassigned.some((id) => {
        const { file, hunk } = hunkMap.get(id);
        return file.status === "conflicted" || hunk.secretFindings.length > 0;
      })
        ? "critical"
        : "review-carefully",
      attentionReason: "Grouping is incomplete or ambiguous.",
      confidence: "low",
      hunkIds: unassigned,
      crossReferences: [],
      reviewAfter: [],
      risks: [],
      questions: ["What implementation purpose connects these changes?"],
      hunkExplanations: {},
    });
  }

  groups.sort((a, b) => ATTENTION_ORDER[a.attention] - ATTENTION_ORDER[b.attention]);
  return {
    schemaVersion: ANALYSIS_SCHEMA,
    sourceSchemaVersion: input?.schemaVersion || null,
    reviewPath: {
      summary: String(input?.reviewPath?.summary || "Review higher-attention groups first, then follow dependency links."),
      checks: Array.isArray(input?.reviewPath?.checks) ? input.reviewPath.checks.map(String) : [],
    },
    verification: Array.isArray(input?.verification)
      ? input.verification.map((item) => ({
          command: String(item?.command || "Unknown command"),
          status: ["passed", "failed", "not-run"].includes(item?.status) ? item.status : "not-run",
          note: String(item?.note || ""),
        }))
      : [],
    groups,
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

function compactFlags(lines, forceCompact) {
  if (!forceCompact) return lines.map(() => false);
  const changed = lines
    .map((line, index) => (line.kind === "add" || line.kind === "delete" ? index : -1))
    .filter((index) => index >= 0);
  return lines.map((line, index) => {
    if (line.kind !== "context") return false;
    return !changed.some((changedIndex) => Math.abs(changedIndex - index) <= 3);
  });
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

function hunkMarkup(file, hunk, explanation, forceCompact) {
  const contextFlags = compactFlags(hunk.lines, true);
  const omittedContext = forceCompact && contextFlags.some(Boolean);
  const displayLines = forceCompact
    ? hunk.lines.filter((_, index) => !contextFlags[index])
    : hunk.lines;
  const flags = forceCompact
    ? displayLines.map(() => false)
    : contextFlags;
  const hasExtra = flags.some(Boolean);
  const secretMarkup = hunk.secretFindings.length
    ? `<div class="signal critical-signal">Potential secret pattern detected on added line${hunk.secretFindings.length === 1 ? "" : "s"} ${hunk.secretFindings.map((finding) => finding.newLine).join(", ")}.</div>`
    : "";
  return `<article class="hunk" id="${escapeHtml(slug(hunk.id))}" data-search="${escapeHtml(`${file.path} ${explanation || ""} ${hunk.lines.map((line) => line.text).join(" ")}`)}">
    <header class="hunk-head">
      <div>
        <a class="path" href="#${escapeHtml(slug(hunk.id))}">${escapeHtml(file.oldPath !== file.newPath ? `${file.oldPath} → ${file.newPath}` : file.path)}</a>
        <span class="state">${escapeHtml(file.stageState)}</span>
        ${isGenerated(file.path) ? '<span class="state generated">generated / lockfile</span>' : ""}
      </div>
      <button class="copy-link" data-anchor="${escapeHtml(slug(hunk.id))}" title="Copy link">#</button>
    </header>
    <p class="hunk-explanation"><span>AI analysis</span>${escapeHtml(explanation || "No hunk explanation was provided.")}</p>
    ${secretMarkup}
    ${file.status === "conflicted" ? '<div class="signal critical-signal">Unresolved merge conflict.</div>' : ""}
    ${file.isBinary ? `<div class="binary">Binary change · ${escapeHtml(file.status)} · ${escapeHtml(formatBytes(file.size))}</div>` : hunk.metadataOnly ? `
      <div class="binary">Metadata-only change · ${escapeHtml(hunk.header)}</div>
    ` : `
      <div class="hunk-label">${escapeHtml(hunk.header)}</div>
      ${omittedContext ? '<div class="signal">Extended unchanged context omitted to keep the report below 25 MB.</div>' : ""}
      <div class="diff unified-view">
        <table><tbody>${displayLines.map((line, index) => lineRow(line, file.path, flags[index])).join("")}</tbody></table>
      </div>
      <div class="diff side-view" hidden>
        <table><tbody>${sideRows(displayLines, file.path, flags)}</tbody></table>
      </div>
      ${hasExtra ? '<button class="expand-context">Show embedded context</button>' : ""}
    `}
  </article>`;
}

function groupMarkup(group, hunkMap, forceCompact) {
  const entries = group.hunkIds.map((id) => hunkMap.get(id)).filter(Boolean);
  const stats = { files: new Set(), hunks: entries.length, additions: 0, deletions: 0 };
  for (const { file, hunk } of entries) {
    stats.files.add(file.path);
    for (const line of hunk.lines) {
      if (line.kind === "add") stats.additions += 1;
      if (line.kind === "delete") stats.deletions += 1;
    }
  }
  const lists = [
    group.risks.length ? `<section class="notes"><h4>Review attention</h4><ul>${group.risks.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : "",
    group.questions.length ? `<section class="notes"><h4>Questions</h4><ul>${group.questions.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : "",
  ].join("");
  const dependencies = group.reviewAfter.length
    ? `<p class="dependencies">Review after: ${group.reviewAfter.map((id) => `<a href="#group-${escapeHtml(slug(id))}">${escapeHtml(id)}</a>`).join(", ")}</p>`
    : "";

  return `<section class="intent-group" id="group-${escapeHtml(group.id)}" data-group="${escapeHtml(group.id)}" data-search="${escapeHtml(`${group.title} ${group.summary} ${group.risks.join(" ")} ${group.questions.join(" ")}`)}">
    <header class="group-head">
      <div class="group-title-row">
        <span class="attention ${group.attention}">${group.attention === "review-carefully" ? "Review carefully" : group.attention}</span>
        <span class="confidence">AI confidence: ${escapeHtml(group.confidence)}</span>
        <button class="copy-link" data-anchor="group-${escapeHtml(group.id)}" title="Copy link">#</button>
      </div>
      <h2>${escapeHtml(group.title)}</h2>
      <p>${escapeHtml(group.summary)}</p>
      ${group.attentionReason ? `<p class="attention-reason">${escapeHtml(group.attentionReason)}</p>` : ""}
      <div class="group-stats"><span>${stats.files.size} files</span><span>${stats.hunks} hunks</span><span class="plus">+${stats.additions}</span><span class="minus">−${stats.deletions}</span></div>
      ${dependencies}
    </header>
    ${lists}
    <div class="hunks">${entries.map(({ file, hunk }) => hunkMarkup(file, hunk, group.hunkExplanations[hunk.id], forceCompact)).join("")}</div>
  </section>`;
}

function buildHtml(capture, analysis, forceCompact = false) {
  const hunkMap = new Map();
  for (const file of capture.files) {
    for (const hunk of file.hunks) hunkMap.set(hunk.id, { file, hunk });
  }
  const title = `Human-Friendly Diff — ${capture.repository.name} — ${capture.repository.branch}`;
  const verification = analysis.verification.length
    ? analysis.verification.map((item) => `<li><span class="verify ${item.status}">${escapeHtml(item.status)}</span><code>${escapeHtml(item.command)}</code>${item.note ? ` — ${escapeHtml(item.note)}` : ""}</li>`).join("")
    : '<li><span class="verify not-run">not reported</span> No verification results were supplied by the active agent.</li>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{color-scheme:dark;--ink:#eef2dc;--muted:#8d9787;--bg:#0a0c0b;--panel:#111510;--panel2:#171c15;--line:#30372d;--acid:#e7ff55;--cyan:#6ee7e0;--red:#ff6b68;--orange:#ffad54;--green:#79dc83;--add:#102a19;--del:#321716;--shadow:0 20px 50px rgba(0,0,0,.32)}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 82% 0,#182117 0,transparent 31rem),var(--bg);color:var(--ink);font-family:"IBM Plex Sans","Avenir Next","Segoe UI",sans-serif;font-size:15px;line-height:1.5}
    button,input{font:inherit}button{color:inherit}.app{display:grid;grid-template-columns:290px minmax(0,1fr);min-height:100vh}.sidebar{position:sticky;top:0;height:100vh;padding:24px 18px;border-right:1px solid var(--line);background:rgba(10,12,11,.92);backdrop-filter:blur(18px);overflow:auto}.brand{display:flex;align-items:center;gap:10px;margin-bottom:24px;font-family:"Arial Narrow","Roboto Condensed",sans-serif;font-size:12px;font-weight:800;letter-spacing:.18em;text-transform:uppercase}.brand-mark{width:20px;height:20px;background:var(--acid);clip-path:polygon(0 0,100% 0,67% 100%,0 100%)}.search{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:6px;background:#080a09;color:var(--ink);outline:none}.search:focus{border-color:var(--acid);box-shadow:0 0 0 3px #e7ff5522}.sidebar h3{margin:22px 0 9px;color:var(--muted);font-size:11px;letter-spacing:.14em;text-transform:uppercase}.group-nav{display:grid;gap:5px}.nav-item{display:grid;grid-template-columns:18px 1fr;gap:9px;align-items:start;padding:9px 8px;border-radius:6px;color:var(--ink);text-decoration:none}.nav-item:hover{background:var(--panel2)}.nav-item input{margin-top:3px;accent-color:var(--acid)}.nav-copy{min-width:0}.nav-title{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}.nav-attention{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.sidebar-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}.small-btn,.view-toggle button,.copy-link,.expand-context{border:1px solid var(--line);border-radius:5px;background:var(--panel);cursor:pointer}.small-btn{padding:8px;font-size:12px}.small-btn:hover,.view-toggle button:hover,.copy-link:hover,.expand-context:hover{border-color:var(--acid)}
    main{min-width:0;padding:42px clamp(20px,4vw,68px) 100px}.hero{position:relative;max-width:1280px;margin:0 auto 28px;padding:30px;border:1px solid var(--line);background:linear-gradient(135deg,#151b13,#0d100e 65%);box-shadow:var(--shadow);overflow:hidden}.hero:after{content:"";position:absolute;right:-50px;top:-90px;width:250px;height:250px;border:54px solid #e7ff5511;transform:rotate(18deg)}.eyebrow{color:var(--acid);font-size:11px;font-weight:800;letter-spacing:.17em;text-transform:uppercase}.hero h1{max-width:900px;margin:8px 0 3px;font-family:"Arial Narrow","Roboto Condensed",sans-serif;font-size:clamp(32px,5vw,64px);line-height:.98;letter-spacing:-.035em}.meta{display:flex;flex-wrap:wrap;gap:7px 18px;color:var(--muted);font-family:"SFMono-Regular",Consolas,monospace;font-size:12px}.stats{display:flex;flex-wrap:wrap;gap:14px;margin-top:22px}.stat{min-width:100px;padding:13px 15px;border-left:2px solid var(--acid);background:#090b09}.stat strong{display:block;font-size:22px}.stat span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.1em}.toolbar{position:sticky;top:12px;z-index:10;display:flex;justify-content:space-between;align-items:center;gap:12px;max-width:1280px;margin:0 auto 18px;padding:8px;border:1px solid var(--line);border-radius:8px;background:#0c0f0de8;backdrop-filter:blur(14px)}.view-toggle{display:flex}.view-toggle button{padding:7px 12px;border-radius:4px}.view-toggle button.active{background:var(--acid);color:#0a0c0b;border-color:var(--acid);font-weight:800}.review-path,.verification{max-width:1280px;margin:0 auto 18px;padding:18px 20px;border:1px solid var(--line);background:var(--panel)}.review-path h2,.verification h2{margin:0 0 7px;font-size:15px}.review-path p{margin:0;color:var(--muted)}.review-path ul,.verification ul{margin:9px 0 0;padding-left:20px}.verify{display:inline-block;margin-right:8px;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:800;text-transform:uppercase}.verify.passed{background:#173c20;color:var(--green)}.verify.failed{background:#481b19;color:var(--red)}.verify.not-run{background:#302c1a;color:var(--orange)}
    .groups{display:grid;gap:24px;max-width:1280px;margin:0 auto}.intent-group{scroll-margin-top:82px;border:1px solid var(--line);background:var(--panel);box-shadow:var(--shadow)}.group-head{padding:24px 26px;border-bottom:1px solid var(--line);background:linear-gradient(120deg,#171c15,#101310)}.group-title-row{display:flex;align-items:center;gap:10px}.attention{display:inline-flex;padding:4px 8px;border:1px solid;border-radius:999px;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}.attention.routine{color:var(--green);border-color:#79dc8366;background:#79dc8312}.attention.review-carefully{color:var(--orange);border-color:#ffad5466;background:#ffad5412}.attention.critical{color:var(--red);border-color:#ff6b6866;background:#ff6b6812}.confidence{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.07em}.copy-link{margin-left:auto;width:28px;height:28px;color:var(--muted)}.group-head h2{margin:13px 0 5px;font-family:"Arial Narrow","Roboto Condensed",sans-serif;font-size:30px;line-height:1.05}.group-head>p{max-width:900px;margin:6px 0;color:#c3cabd}.attention-reason{font-size:12px!important;color:var(--muted)!important}.group-stats{display:flex;gap:13px;margin-top:13px;font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;color:var(--muted)}.plus{color:var(--green)}.minus{color:var(--red)}.dependencies{font-size:12px}.dependencies a{color:var(--cyan)}.notes{margin:16px 26px;padding:12px 15px;border-left:2px solid var(--orange);background:#16150f}.notes h4{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.1em}.notes ul{margin:0;padding-left:20px;color:#c3cabd}.hunks{display:grid;gap:1px;background:var(--line)}.hunk{min-width:0;background:#0d100e;scroll-margin-top:82px}.hunk-head{display:flex;justify-content:space-between;align-items:center;padding:10px 13px;background:#151a14}.path{color:var(--cyan);font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;text-decoration:none}.state{margin-left:7px;padding:2px 5px;border:1px solid var(--line);border-radius:3px;color:var(--muted);font-size:9px;text-transform:uppercase}.state.generated{color:var(--orange)}.hunk-explanation{display:flex;gap:10px;margin:0;padding:10px 13px;border-top:1px solid #20251e;color:#c7cec1;font-size:13px}.hunk-explanation span{flex:none;color:var(--acid);font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.hunk-label{padding:6px 12px;background:#121812;color:#839779;font-family:"SFMono-Regular",Consolas,monospace;font-size:11px}.diff{overflow:auto}.diff table{width:100%;border-collapse:collapse;font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;line-height:1.45}.diff td{padding:0;vertical-align:top}.ln{width:48px;min-width:48px;padding:0 8px!important;background:#101310;color:#596154;text-align:right;user-select:none;border-right:1px solid #242a22}.marker{width:24px;min-width:24px;text-align:center;user-select:none}.code{width:auto;white-space:pre;padding:0 10px!important}.diff-line.add,.side-line .add{background:var(--add)}.diff-line.delete,.side-line .delete{background:var(--del)}.diff-line.add .marker{color:var(--green)}.diff-line.delete .marker{color:var(--red)}.side-view .code{width:50%;max-width:0;overflow:hidden}.side-view td:nth-child(2){border-right:1px solid var(--line)}.extra-context{display:none}.hunk.context-open .extra-context{display:table-row}.expand-context{margin:9px 12px;padding:6px 9px;color:var(--muted);font-size:11px}.binary,.signal{padding:18px}.critical-signal{color:#ffd3d1;background:#391817;border-left:3px solid var(--red)}.tok-comment{color:#6d7d67}.tok-string{color:#c7db8d}.tok-number,.tok-literal{color:#e7a96b}.tok-keyword{color:#76cfe0}.empty-search{display:none;max-width:1280px;margin:30px auto;color:var(--muted);text-align:center}.footer{max-width:1280px;margin:30px auto 0;color:var(--muted);font-size:11px;text-align:center}
    :focus-visible{outline:2px solid var(--acid);outline-offset:2px}@media(max-width:900px){.app{display:block}.sidebar{position:relative;width:100%;height:auto;border-right:0;border-bottom:1px solid var(--line)}.group-nav{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}main{padding-top:24px}.toolbar{top:6px}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
  </style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark"></span>Human-Friendly Diff</div>
    <input id="search" class="search" type="search" placeholder="Search changes…" aria-label="Search report">
    <h3>Review groups</h3>
    <nav class="group-nav">${analysis.groups.map((group) => `<a class="nav-item" href="#group-${escapeHtml(group.id)}" data-nav-group="${escapeHtml(group.id)}"><input type="checkbox" aria-label="Mark ${escapeHtml(group.title)} reviewed"><span class="nav-copy"><span class="nav-title">${escapeHtml(group.title)}</span><span class="nav-attention">${escapeHtml(group.attention)}</span></span></a>`).join("")}</nav>
    <h3>Report</h3>
    <div class="sidebar-actions"><button class="small-btn" id="download-analysis">Analysis JSON</button><button class="small-btn" id="collapse-all">Collapse groups</button></div>
  </aside>
  <main>
    <header class="hero">
      <div class="eyebrow">Working tree snapshot</div>
      <h1>${escapeHtml(capture.repository.name)}<br><span style="color:var(--muted)">${escapeHtml(capture.repository.branch)}</span></h1>
      <div class="meta"><span>HEAD ${escapeHtml(capture.repository.head)}</span><span>${escapeHtml(capture.generatedAt)}</span><span>snapshot ${escapeHtml(capture.repository.fingerprint.slice(0, 12))}</span></div>
      <div class="stats"><div class="stat"><strong>${capture.stats.files}</strong><span>files</span></div><div class="stat"><strong>${capture.stats.hunks}</strong><span>hunks</span></div><div class="stat"><strong class="plus">+${capture.stats.additions}</strong><span>additions</span></div><div class="stat"><strong class="minus">−${capture.stats.deletions}</strong><span>deletions</span></div></div>
    </header>
    <div class="toolbar"><div class="view-toggle"><button class="active" data-view="unified">Unified</button><button data-view="side">Side by side</button></div><span class="meta">Grouped by inferred purpose · exact Git snapshot</span></div>
    <section class="review-path"><h2>Suggested review path <span class="confidence">AI analysis</span></h2><p>${escapeHtml(analysis.reviewPath.summary)}</p>${analysis.reviewPath.checks.length ? `<ul>${analysis.reviewPath.checks.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}</section>
    <section class="verification"><h2>Verification observed</h2><ul>${verification}</ul></section>
    <div class="empty-search" id="empty-search">No intent groups match this search.</div>
    <div class="groups">${analysis.groups.map((group) => groupMarkup(group, hunkMap, forceCompact)).join("")}</div>
    <div class="footer">Generated locally by Human-Friendly Diff · ${escapeHtml(capture.repository.fingerprint)}</div>
  </main>
</div>
<script id="analysis-data" type="application/json">${safeJson(analysis)}</script>
<script>
  const fingerprint = ${safeJson(capture.repository.fingerprint)};
  const storageKey = "hfd:" + fingerprint;
  const state = JSON.parse(sessionStorage.getItem(storageKey) || "{}");
  document.querySelectorAll("[data-nav-group]").forEach((link) => {
    const id = link.dataset.navGroup;
    const checkbox = link.querySelector("input");
    checkbox.checked = Boolean(state[id]);
    checkbox.addEventListener("click", (event) => {
      event.stopPropagation();
      state[id] = checkbox.checked;
      sessionStorage.setItem(storageKey, JSON.stringify(state));
    });
  });
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("active", item === button));
    const side = button.dataset.view === "side";
    document.querySelectorAll(".unified-view").forEach((item) => item.hidden = side);
    document.querySelectorAll(".side-view").forEach((item) => item.hidden = !side);
  }));
  document.querySelectorAll(".expand-context").forEach((button) => button.addEventListener("click", () => {
    const hunk = button.closest(".hunk");
    hunk.classList.toggle("context-open");
    button.textContent = hunk.classList.contains("context-open") ? "Hide embedded context" : "Show embedded context";
  }));
  document.querySelectorAll(".copy-link").forEach((button) => button.addEventListener("click", async () => {
    const url = location.href.split("#")[0] + "#" + button.dataset.anchor;
    try { await navigator.clipboard.writeText(url); button.textContent = "✓"; setTimeout(() => button.textContent = "#", 900); }
    catch { location.hash = button.dataset.anchor; }
  }));
  document.querySelector("#download-analysis").addEventListener("click", () => {
    const data = document.querySelector("#analysis-data").textContent;
    const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: "human-friendly-diff-analysis.json" });
    link.click(); URL.revokeObjectURL(url);
  });
  document.querySelector("#collapse-all").addEventListener("click", () => {
    document.querySelectorAll(".intent-group").forEach((group) => {
      const hunks = group.querySelector(".hunks");
      hunks.hidden = !hunks.hidden;
    });
  });
  const search = document.querySelector("#search");
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    document.querySelectorAll(".intent-group").forEach((group) => {
      const match = !query || group.textContent.toLowerCase().includes(query);
      group.hidden = !match;
      const nav = document.querySelector('[data-nav-group="' + group.dataset.group + '"]');
      if (nav) nav.hidden = !match;
      if (match) visible += 1;
    });
    document.querySelector("#empty-search").style.display = visible ? "none" : "block";
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && document.activeElement !== search) { event.preventDefault(); search.focus(); }
    if (event.key === "Escape" && document.activeElement === search) { search.value = ""; search.dispatchEvent(new Event("input")); search.blur(); }
  });
</script>
</body>
</html>`;
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
    process.stderr.write(`Analysis could not be read; rendering fallback groups: ${error.message}\n`);
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
