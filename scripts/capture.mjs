#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const CAPTURE_SCHEMA = "human-friendly-diff.capture/v3";
const MAX_SNAPSHOT_BYTES = 512 * 1024;

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

function git(repo, args, options = {}) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: 1024 * 1024 * 512,
    stdio: ["ignore", "pipe", options.allowFailure ? "ignore" : "pipe"],
  });
}

function gitOptional(repo, args) {
  try {
    return git(repo, args).trim();
  } catch {
    return "";
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizePath(path) {
  return path.replace(/^"|"$/g, "").replace(/^a\//, "").replace(/^b\//, "");
}

function changeKind(path) {
  const normalized = path.toLowerCase();
  if (/(^|\/)(?:test|tests|__tests__|spec|specs|fixtures)(\/|$)|\.(?:test|spec)\.[^/]+$/.test(normalized)) {
    return "test";
  }
  if (
    /(^|\/)(?:docs?|examples?|scripts?|config)(\/|$)/.test(normalized) ||
    /(^|\/)(?:\.env(?:\.[^/]*)?|[^/]*config\.[^/]+)$/.test(normalized) ||
    /(?:^|\/)(?:readme|license|changelog)(?:\.[^/]*)?$/.test(normalized) ||
    /(?:^|\/)(?:package-lock|pnpm-lock|yarn\.lock|cargo\.lock|composer\.lock)$/.test(normalized) ||
    /\.(?:md|mdx|txt|json|ya?ml|toml|lock)$/.test(normalized)
  ) {
    return "other";
  }
  return "production";
}

function boundedText(buffer) {
  if (!buffer || buffer.includes(0)) return { available: false, reason: "binary" };
  if (buffer.length > MAX_SNAPSHOT_BYTES) {
    return { available: false, reason: "large-file", bytes: buffer.length };
  }
  return { available: true, text: buffer.toString("utf8"), bytes: buffer.length };
}

function captureSnapshots(repoRoot, file, base, head) {
  let before = { available: false, reason: file.status === "added" ? "added-file" : "unavailable" };
  let after = { available: false, reason: file.status === "deleted" ? "deleted-file" : "unavailable" };
  if (file.status !== "added") {
    try {
      before = boundedText(Buffer.from(git(repoRoot, ["show", `${base}:${file.oldPath}`], { encoding: null })));
    } catch {
      before = { available: false, reason: "unavailable" };
    }
  }
  if (file.status !== "deleted") {
    try {
      after = boundedText(Buffer.from(git(repoRoot, ["show", `${head}:${file.path}`], { encoding: null })));
    } catch {
      after = { available: false, reason: "unavailable" };
    }
  }
  return { before, after };
}

function parseRange(value) {
  const match = value.match(/^-(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?/);
  if (!match) return { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0 };
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };
}

function detectSecrets(lines) {
  const patterns = [
    ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
    ["github-token", /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/],
    ["generic-secret", /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"']{8,}["']/i],
  ];
  const findings = [];
  for (const line of lines) {
    if (line.kind !== "add") continue;
    for (const [type, pattern] of patterns) {
      if (pattern.test(line.text)) findings.push({ type, newLine: line.newLine });
    }
  }
  return findings;
}

function parseDiff(rawDiff) {
  const files = [];
  const sections = rawDiff.split(/(?=^diff --git )/m).filter(Boolean);

  for (const section of sections) {
    const rawLines = section.replace(/\n$/, "").split("\n");
    const header = rawLines[0]?.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!header) continue;

    let oldPath = sanitizePath(header[1]);
    let newPath = sanitizePath(header[2]);
    let status = "modified";
    let isBinary = false;
    let oldMode = null;
    let newMode = null;
    const metadata = [];
    const hunks = [];

    for (let index = 1; index < rawLines.length; index += 1) {
      const line = rawLines[index];
      if (line.startsWith("new file mode ")) {
        status = "added";
        newMode = line.slice("new file mode ".length);
        metadata.push(line);
      } else if (line.startsWith("deleted file mode ")) {
        status = "deleted";
        oldMode = line.slice("deleted file mode ".length);
        metadata.push(line);
      } else if (line.startsWith("old mode ")) {
        oldMode = line.slice("old mode ".length);
        metadata.push(line);
      } else if (line.startsWith("new mode ")) {
        newMode = line.slice("new mode ".length);
        metadata.push(line);
      } else if (line.startsWith("rename from ")) {
        status = "renamed";
        oldPath = line.slice("rename from ".length);
        metadata.push(line);
      } else if (line.startsWith("rename to ")) {
        newPath = line.slice("rename to ".length);
        metadata.push(line);
      } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        isBinary = true;
        metadata.push(line);
      } else if (line.startsWith("index ") || line.startsWith("similarity index ")) {
        metadata.push(line);
      } else if (line.startsWith("@@ ")) {
        const range = parseRange(line.slice(3));
        const hunkLines = [];
        let oldLine = range.oldStart;
        let newLine = range.newStart;
        const hunkHeader = line;
        index += 1;
        while (index < rawLines.length && !rawLines[index].startsWith("@@ ")) {
          const diffLine = rawLines[index];
          if (diffLine.startsWith("diff --git ")) break;
          let kind = "context";
          let text = diffLine;
          let lineOld = null;
          let lineNew = null;
          if (diffLine.startsWith("+") && !diffLine.startsWith("+++")) {
            kind = "add";
            text = diffLine.slice(1);
            lineNew = newLine++;
          } else if (diffLine.startsWith("-") && !diffLine.startsWith("---")) {
            kind = "delete";
            text = diffLine.slice(1);
            lineOld = oldLine++;
          } else if (diffLine.startsWith(" ")) {
            text = diffLine.slice(1);
            lineOld = oldLine++;
            lineNew = newLine++;
          } else if (diffLine === "\\ No newline at end of file") {
            kind = "meta";
          } else {
            index -= 1;
            break;
          }
          hunkLines.push({ kind, text, oldLine: lineOld, newLine: lineNew });
          index += 1;
        }
        index -= 1;
        const id = `${newPath || oldPath}::${hunks.length}`;
        hunks.push({
          id,
          header: hunkHeader,
          ...range,
          lines: hunkLines,
          secretFindings: detectSecrets(hunkLines),
        });
      }
    }

    const path = newPath === "/dev/null" ? oldPath : newPath;
    if (hunks.length === 0) {
      hunks.push({
        id: `${path}::0`,
        header: metadata.join(" · ") || `${status} file`,
        oldStart: 0,
        oldCount: 0,
        newStart: 0,
        newCount: 0,
        lines: [],
        secretFindings: [],
        metadataOnly: true,
      });
    }
    files.push({
      path,
      oldPath,
      newPath,
      status,
      stageState: "branch",
      isBinary,
      objectType: newMode === "120000" || oldMode === "120000" ? "symlink" : "file",
      symlinkTarget: null,
      size: null,
      oldMode,
      newMode,
      metadata,
      hunks,
      rawDiff: section,
    });
  }
  return files;
}

function summarize(files) {
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  const changeLines = {
    production: { additions: 0, deletions: 0, total: 0 },
    test: { additions: 0, deletions: 0, total: 0 },
    other: { additions: 0, deletions: 0, total: 0 },
  };
  for (const file of files) {
    for (const hunk of file.hunks) {
      hunks += 1;
      for (const line of hunk.lines) {
        if (line.kind === "add") {
          additions += 1;
          changeLines[file.changeKind].additions += 1;
          changeLines[file.changeKind].total += 1;
        }
        if (line.kind === "delete") {
          deletions += 1;
          changeLines[file.changeKind].deletions += 1;
          changeLines[file.changeKind].total += 1;
        }
      }
    }
  }
  return { files: files.length, hunks, additions, deletions, changeLines };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const requestedRepo = resolve(String(args.repo || process.cwd()));
  const output = args.output ? resolve(String(args.output)) : null;
  const baseRef = args.base ? String(args.base) : null;
  if (!output) throw new Error("Missing required --output <capture.json>");
  if (!baseRef) throw new Error("Missing required --base <target-branch>");

  const repoRoot = realpathSync(git(requestedRepo, ["rev-parse", "--show-toplevel"]).trim());
  const insideWorkTree = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]).trim();
  if (insideWorkTree !== "true") throw new Error("Not inside a Git working tree");

  const head = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const base = git(repoRoot, ["rev-parse", "--verify", `${baseRef}^{commit}`]).trim();
  const mergeBase = git(repoRoot, ["merge-base", base, head]).trim();
  const rawDiff = git(repoRoot, [
    "diff",
    mergeBase,
    head,
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "--find-copies",
    "--unified=20",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ]);

  const files = parseDiff(rawDiff);
  for (const file of files) {
    file.changeKind = changeKind(file.path);
    file.snapshots = captureSnapshots(repoRoot, file, mergeBase, head);
    file.size = file.snapshots.after.bytes ?? file.snapshots.before.bytes ?? null;
  }
  const shortHead = head.slice(0, 12);
  const shortBase = base.slice(0, 12);
  const shortMergeBase = mergeBase.slice(0, 12);
  const branch = gitOptional(repoRoot, ["branch", "--show-current"]) || `detached@${head}`;
  const repoName = basename(repoRoot);
  const fingerprint = sha256(`${base}\0${mergeBase}\0${head}\0${rawDiff}`);

  const capture = {
    schemaVersion: CAPTURE_SCHEMA,
    generatedAt: new Date().toISOString(),
    repository: {
      name: repoName,
      branch,
      head: shortHead,
      target: { ref: baseRef, commit: shortBase, mergeBase: shortMergeBase },
      fingerprint,
    },
    clean: files.length === 0,
    stats: summarize(files),
    files,
  };

  writeFileSync(output, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  process.stdout.write(
    capture.clean
      ? "No branch changes.\n"
      : `Captured ${capture.stats.hunks} hunks across ${capture.stats.files} files from ${baseRef}...${branch}: ${output}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`human-friendly-diff capture failed: ${error.message}\n`);
  process.exitCode = 1;
}
