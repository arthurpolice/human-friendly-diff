---
name: human-friendly-diff
description: Generate and open a self-contained HTML review of the current Git working tree, grouping exact diff hunks by inferred implementation intent. Use when the user asks for a human-friendly diff, semantic diff, intent-grouped diff, or easier review of agent-generated changes.
---

# Human-Friendly Diff

Create a local HTML review of the current repository's staged, unstaged, and
untracked non-ignored changes.

## Requirements

- Run only inside a Git repository.
- Require Node.js 20 or newer.
- Treat the working tree as the review scope. It may include pre-existing user
  changes; do not claim every change was authored by the active agent.
- Capture and rendering are local. Do not make network requests.

## Workflow

Resolve this skill directory and use its plugin root for all script paths.

1. Create a unique temporary working directory under
   `/tmp/human-friendly-diff/work/`.
2. Run:

   ```sh
   node <plugin-root>/scripts/capture.mjs \
     --repo "$PWD" \
     --output <work-dir>/capture.json
   ```

3. If capture reports a clean working tree, tell the user and stop. Do not
   generate an empty report.
4. Read `capture.json`. Selectively inspect changed files, directly referenced
   symbols, nearby tests, and project/domain guidance when useful. Keep this
   inspection read-only and relevance-driven.
5. Produce `<work-dir>/analysis.json` following
   `<plugin-root>/docs/annotation-schema.md`.
   - Group by inferred implementation purpose, not paths.
   - A file may contribute hunks to multiple groups.
   - Each hunk has one primary group; use cross-references for secondary intent.
   - Keep tests and docs with the behavior they support.
   - Order groups by attention, then dependency/review order.
   - Explain every hunk in one line using relevant symbols where possible.
   - Add review questions for plausible missing companion changes.
   - Report only verification actually observed in this agent session.
6. Render and launch:

   ```sh
   node <plugin-root>/scripts/render.mjs \
     --capture <work-dir>/capture.json \
     --analysis <work-dir>/analysis.json \
     --open
   ```

7. Return the generated absolute HTML path. Browser launch failure is not report
   generation failure.

## Failure behavior

- Never omit or reconstruct captured diff content.
- If context limits prevent confident grouping, classify what you can and leave
  the rest unassigned. The renderer places it in `Needs classification`.
- If analysis JSON is incomplete, still render; the renderer safely repairs it.
- Do not run tests or mutate the reviewed repository as part of report
  generation.
