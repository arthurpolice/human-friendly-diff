import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 50,
  });
}

function fixtureRepo() {
  const repo = mkdtempSync(resolve(tmpdir(), "hfd-fixture-"));
  run("git", ["init", "-q"], repo);
  run("git", ["config", "user.email", "test@example.com"], repo);
  run("git", ["config", "user.name", "Test User"], repo);
  writeFileSync(resolve(repo, "checkout.js"), "export function submit(order) {\n  return order.id;\n}\n");
  writeFileSync(resolve(repo, "checkout.test.js"), "import { submit } from './checkout.js';\nvoid submit;\n");
  writeFileSync(resolve(repo, "README.md"), "# Fixture\n");
  run("git", ["add", "."], repo);
  run("git", ["commit", "-qm", "initial"], repo);
  run("git", ["branch", "-M", "main"], repo);
  run("git", ["switch", "-qc", "feature"], repo);
  return repo;
}

test("capture compares committed branch changes to its target and ignores the working tree", () => {
  const repo = fixtureRepo();
  const capturePath = resolve(repo, "capture.json");

  writeFileSync(
    resolve(repo, "checkout.js"),
    "export function submit(order) {\n  if (!order.id) throw new Error('missing id');\n  return order.id;\n}\n",
  );
  writeFileSync(resolve(repo, "checkout.test.js"), "import { submit } from './checkout.js';\nsubmit({ id: 42 });\n");
  run("git", ["add", "checkout.js", "checkout.test.js"], repo);
  run("git", ["commit", "-qm", "validate checkout"], repo);
  writeFileSync(
    resolve(repo, "checkout.js"),
    "export function submit(order) {\n  if (!order.id) throw new Error('missing id');\n  return String(order.id);\n}\n",
  );
  writeFileSync(resolve(repo, "token.js"), "export const apiKey = 'super-secret-value';\n");

  run("node", [resolve(ROOT, "scripts/capture.mjs"), "--repo", repo, "--base", "main", "--output", capturePath], ROOT);
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));

  assert.equal(capture.clean, false);
  assert.equal(capture.schemaVersion, "human-friendly-diff.capture/v3");
  assert.equal(capture.repository.name, repo.split("/").at(-1));
  assert.equal(capture.repository.target.ref, "main");
  assert.ok(capture.files.some((file) => file.path === "checkout.js" && file.stageState === "branch"));
  assert.ok(!capture.files.some((file) => file.path === "token.js"));
  assert.ok(capture.stats.changeLines.production.total > 0);
  assert.ok(capture.stats.changeLines.test.total > 0);
  assert.ok(capture.files.find((file) => file.path === "checkout.js").snapshots.after.available);
  assert.match(capture.files.find((file) => file.path === "checkout.js").snapshots.after.text, /return order\.id/);
  const ids = capture.files.flatMap((file) => file.hunks.map((hunk) => hunk.id));
  assert.equal(new Set(ids).size, ids.length);
});

test("capture requires an explicit target branch", () => {
  const repo = fixtureRepo();
  const capturePath = resolve(repo, "capture.json");
  assert.throws(
    () => run("node", [resolve(ROOT, "scripts/capture.mjs"), "--repo", repo, "--output", capturePath], ROOT),
    /Missing required --base <target-branch>/,
  );
});

test("renderer preserves every hunk as an explicit unresolved finding", () => {
  const repo = fixtureRepo();
  const capturePath = resolve(repo, "capture.json");
  const analysisPath = resolve(repo, "analysis.json");
  const reportPath = resolve(repo, "report.html");

  writeFileSync(resolve(repo, "README.md"), "# Fixture\n\n<script>alert('nope')</script>\n");
  run("git", ["add", "README.md"], repo);
  run("git", ["commit", "-qm", "document fixture"], repo);
  run("node", [resolve(ROOT, "scripts/capture.mjs"), "--repo", repo, "--base", "main", "--output", capturePath], ROOT);
  writeFileSync(analysisPath, JSON.stringify({ schemaVersion: "wrong", groups: [] }));
  run(
    "node",
    [
      resolve(ROOT, "scripts/render.mjs"),
      "--capture",
      capturePath,
      "--analysis",
      analysisPath,
      "--output",
      reportPath,
    ],
    ROOT,
  );

  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const html = readFileSync(reportPath, "utf8");
  assert.match(html, /Intent not inferred/);
  assert.match(html, /class="slide unresolved-slide"/);
  assert.doesNotMatch(html, /Supporting changes/);
  assert.doesNotMatch(html, /No user story/);
  assert.match(html, /class="slide overview-slide"/);
  assert.match(html, /Production vs tests/);
  assert.match(html, /id="next"/);
  assert.doesNotMatch(html, /<script>alert\('nope'\)<\/script>/);
  for (const hunk of capture.files.flatMap((file) => file.hunks)) {
    const anchor = hunk.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    assert.match(html, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("deterministic secret findings raise an annotated story to critical", () => {
  const repo = fixtureRepo();
  const capturePath = resolve(repo, "capture.json");
  const analysisPath = resolve(repo, "analysis.json");
  const reportPath = resolve(repo, "report.html");

  writeFileSync(resolve(repo, "secrets.env"), "API_KEY='hard-coded-secret-value'\n");
  run("git", ["add", "secrets.env"], repo);
  run("git", ["commit", "-qm", "add secret fixture"], repo);
  run("node", [resolve(ROOT, "scripts/capture.mjs"), "--repo", repo, "--base", "main", "--output", capturePath], ROOT);
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const hunkId = capture.files.flatMap((file) => file.hunks)[0].id;
  writeFileSync(
    analysisPath,
    JSON.stringify({
      schemaVersion: "human-friendly-diff.analysis/v3",
      overview: {
        modules: [{ id: "configuration", name: "Configuration module", hunkIds: [hunkId] }],
      },
      stories: [
        {
          id: "config",
          title: "Service starts with local configuration",
          goal: "Make the credential available to the service.",
          attention: "routine",
          confidence: "high",
          steps: [{
            id: "load-config",
            actor: "Service",
            action: "Loads its local configuration",
            outcome: "The credential becomes available.",
            moduleId: "configuration",
            excerpts: [{ hunkId, explanation: "Adds the service credential." }]
          }]
        },
      ],
    }),
  );
  run(
    "node",
    [
      resolve(ROOT, "scripts/render.mjs"),
      "--capture",
      capturePath,
      "--analysis",
      analysisPath,
      "--output",
      reportPath,
    ],
    ROOT,
  );
  const html = readFileSync(reportPath, "utf8");
  assert.match(html, /attention critical/);
  assert.match(html, /Potential secret pattern detected/);
});

test("renderer allows repeated sliced excerpts across chronological story beats", () => {
  const repo = fixtureRepo();
  const capturePath = resolve(repo, "capture.json");
  const analysisPath = resolve(repo, "analysis.json");
  const reportPath = resolve(repo, "report.html");
  writeFileSync(resolve(repo, "checkout.js"), "export function submit(order) {\n  if (!order.id) throw new Error('missing id');\n  return String(order.id);\n}\n");
  run("git", ["add", "checkout.js"], repo);
  run("git", ["commit", "-qm", "validate and normalize checkout"], repo);
  run("node", [resolve(ROOT, "scripts/capture.mjs"), "--repo", repo, "--base", "main", "--output", capturePath], ROOT);
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const hunkId = capture.files.find((file) => file.path === "checkout.js").hunks[0].id;
  writeFileSync(analysisPath, JSON.stringify({
    schemaVersion: "human-friendly-diff.analysis/v3",
    overview: { modules: [{ id: "checkout", name: "Checkout module", summary: "Submits orders.", hunkIds: [hunkId] }] },
    stories: [{
      id: "checkout",
      title: "Customer submits checkout",
      goal: "Validate and return the order identifier.",
      attention: "routine",
      confidence: "high",
      steps: [
        { id: "validate", actor: "Checkout", action: "Validates the order", outcome: "Invalid orders stop.", moduleId: "checkout", excerpts: [{ hunkId, lineStart: 2, lineEnd: 2, explanation: "Validation line." }] },
        { id: "respond", actor: "Checkout", action: "Returns the identifier", outcome: "The caller receives a string.", moduleId: "checkout", excerpts: [{ hunkId, lineStart: 2, lineEnd: 4, explanation: "Same hunk reused for the response." }] }
      ]
    }],
    verification: []
  }));
  run("node", [resolve(ROOT, "scripts/render.mjs"), "--capture", capturePath, "--analysis", analysisPath, "--output", reportPath], ROOT);
  const html = readFileSync(reportPath, "utf8");
  assert.match(html, /Customer submits checkout/);
  assert.match(html, /Validation line/);
  assert.match(html, /Same hunk reused for the response/);
  assert.equal((html.match(/checkout\.js/g) || []).length >= 2, true);
  assert.match(html, /Expand full file context/);
});
