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
  writeFileSync(resolve(repo, "README.md"), "# Fixture\n");
  run("git", ["add", "."], repo);
  run("git", ["commit", "-qm", "initial"], repo);
  return repo;
}

test("capture combines staged, unstaged, and untracked changes with stable hunk IDs", () => {
  const repo = fixtureRepo();
  const capturePath = resolve(repo, "capture.json");

  writeFileSync(
    resolve(repo, "checkout.js"),
    "export function submit(order) {\n  if (!order.id) throw new Error('missing id');\n  return order.id;\n}\n",
  );
  run("git", ["add", "checkout.js"], repo);
  writeFileSync(
    resolve(repo, "checkout.js"),
    "export function submit(order) {\n  if (!order.id) throw new Error('missing id');\n  return String(order.id);\n}\n",
  );
  writeFileSync(resolve(repo, "token.js"), "export const apiKey = 'super-secret-value';\n");

  run("node", [resolve(ROOT, "scripts/capture.mjs"), "--repo", repo, "--output", capturePath], ROOT);
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));

  assert.equal(capture.clean, false);
  assert.equal(capture.repository.name, repo.split("/").at(-1));
  assert.ok(capture.files.some((file) => file.path === "checkout.js" && file.stageState === "mixed"));
  assert.ok(capture.files.some((file) => file.path === "token.js"));
  const ids = capture.files.flatMap((file) => file.hunks.map((hunk) => hunk.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(
    capture.files
      .flatMap((file) => file.hunks)
      .some((hunk) => hunk.secretFindings.some((finding) => finding.type === "generic-secret")),
  );
});

test("renderer preserves every hunk and falls back to Needs classification", () => {
  const repo = fixtureRepo();
  const capturePath = resolve(repo, "capture.json");
  const analysisPath = resolve(repo, "analysis.json");
  const reportPath = resolve(repo, "report.html");

  writeFileSync(resolve(repo, "README.md"), "# Fixture\n\n<script>alert('nope')</script>\n");
  run("node", [resolve(ROOT, "scripts/capture.mjs"), "--repo", repo, "--output", capturePath], ROOT);
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
  assert.match(html, /Needs classification/);
  assert.doesNotMatch(html, /<script>alert\('nope'\)<\/script>/);
  for (const hunk of capture.files.flatMap((file) => file.hunks)) {
    const anchor = hunk.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    assert.match(html, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("deterministic secret findings raise an annotated group to critical", () => {
  const repo = fixtureRepo();
  const capturePath = resolve(repo, "capture.json");
  const analysisPath = resolve(repo, "analysis.json");
  const reportPath = resolve(repo, "report.html");

  writeFileSync(resolve(repo, "secrets.env"), "API_KEY='hard-coded-secret-value'\n");
  run("node", [resolve(ROOT, "scripts/capture.mjs"), "--repo", repo, "--output", capturePath], ROOT);
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const hunkId = capture.files.flatMap((file) => file.hunks)[0].id;
  writeFileSync(
    analysisPath,
    JSON.stringify({
      schemaVersion: "human-friendly-diff.analysis/v1",
      groups: [
        {
          id: "config",
          title: "Configure service",
          summary: "Adds local configuration.",
          attention: "routine",
          confidence: "high",
          hunkIds: [hunkId],
          hunkExplanations: { [hunkId]: "Adds the service credential." },
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
