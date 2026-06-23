#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

const CAPTURE_SCHEMA = "human-friendly-diff.capture/v1";

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
    encoding: options.encoding ?? "utf8",
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

function nulList(value) {
  return new Set(value.split("\0").filter(Boolean));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizePath(path) {
  return path.replace(/^"|"$/g, "").replace(/^a\//, "").replace(/^b\//, "");
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

function parseDiff(rawDiff, state) {
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
    const absolutePath = resolve(state.repoRoot, path);
    let size = null;
    let objectType = "file";
    let symlinkTarget = null;
    try {
      const stats = lstatSync(absolutePath);
      size = stats.size;
      if (stats.isSymbolicLink()) {
        objectType = "symlink";
        symlinkTarget = readlinkSync(absolutePath);
      }
    } catch {
      // Deleted files have no working-tree metadata.
    }

    if (state.conflicted.has(path)) status = "conflicted";
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
    const stageState = state.staged.has(path);
    const worktreeState = state.unstaged.has(path);
    files.push({
      path,
      oldPath,
      newPath,
      status,
      stageState: stageState && worktreeState ? "mixed" : stageState ? "staged" : "unstaged",
      isBinary,
      objectType,
      symlinkTarget,
      size,
      oldMode,
      newMode,
      metadata,
      hunks,
      rawDiff: section,
    });
  }
  return files;
}

function quoteDiffPath(path) {
  return path.includes(" ") ? `"${path.replaceAll('"', '\\"')}"` : path;
}

function untrackedSection(repoRoot, path) {
  const absolutePath = resolve(repoRoot, path);
  const stats = lstatSync(absolutePath);
  const quoted = quoteDiffPath(path);
  const header = [
    `diff --git a/${quoted} b/${quoted}`,
    `new file mode ${stats.isSymbolicLink() ? "120000" : "100644"}`,
    "--- /dev/null",
    `+++ b/${quoted}`,
  ];

  let buffer;
  if (stats.isSymbolicLink()) buffer = Buffer.from(readlinkSync(absolutePath), "utf8");
  else buffer = readFileSync(absolutePath);

  if (buffer.includes(0)) {
    return `${header.join("\n")}\nBinary files /dev/null and b/${quoted} differ\n`;
  }

  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  header.push(`@@ -0,0 +1,${lines.length} @@`);
  header.push(...lines.map((line) => `+${line}`));
  if (text && !text.endsWith("\n")) header.push("\\ No newline at end of file");
  return `${header.join("\n")}\n`;
}

function summarize(files) {
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      hunks += 1;
      for (const line of hunk.lines) {
        if (line.kind === "add") additions += 1;
        if (line.kind === "delete") deletions += 1;
      }
    }
  }
  return { files: files.length, hunks, additions, deletions };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const requestedRepo = resolve(String(args.repo || process.cwd()));
  const output = args.output ? resolve(String(args.output)) : null;
  if (!output) throw new Error("Missing required --output <capture.json>");

  const repoRoot = realpathSync(git(requestedRepo, ["rev-parse", "--show-toplevel"]).trim());
  const insideWorkTree = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]).trim();
  if (insideWorkTree !== "true") throw new Error("Not inside a Git working tree");

  const staged = nulList(git(repoRoot, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACDMRTUXB"]));
  const unstaged = nulList(git(repoRoot, ["diff", "--name-only", "-z", "--diff-filter=ACDMRTUXB"]));
  const conflicted = nulList(git(repoRoot, ["diff", "--name-only", "-z", "--diff-filter=U"]));
  const untracked = [...nulList(git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]))];

  let rawDiff = git(repoRoot, [
    "diff",
    "HEAD",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    "--find-copies",
    "--unified=20",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ]);

  for (const path of untracked) rawDiff += untrackedSection(repoRoot, path);

  const state = { repoRoot, staged, unstaged, conflicted };
  const files = parseDiff(rawDiff, state);
  const head = gitOptional(repoRoot, ["rev-parse", "--short=12", "HEAD"]) || "unborn";
  const branch = gitOptional(repoRoot, ["branch", "--show-current"]) || `detached@${head}`;
  const repoName = basename(repoRoot);
  const fingerprint = sha256(`${head}\0${rawDiff}`);

  const capture = {
    schemaVersion: CAPTURE_SCHEMA,
    generatedAt: new Date().toISOString(),
    repository: { name: repoName, branch, head, fingerprint },
    clean: files.length === 0,
    stats: summarize(files),
    files,
  };

  writeFileSync(output, `${JSON.stringify(capture, null, 2)}\n`, "utf8");
  process.stdout.write(
    capture.clean
      ? "Working tree is clean.\n"
      : `Captured ${capture.stats.hunks} hunks across ${capture.stats.files} files: ${output}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`human-friendly-diff capture failed: ${error.message}\n`);
  process.exitCode = 1;
}
