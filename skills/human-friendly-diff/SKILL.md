---
name: human-friendly-diff
description: Generate and open a self-contained slide presentation comparing the current Git branch against a target branch, organizing exact diff excerpts into functional modules and chronological system stories. Use for PR-style diffs, semantic diffs, story-driven diffs, or easier branch-review.
---

# Human-Friendly Diff

Create a local HTML review of the current branch relative to a target branch,
using their merge base as a pull request would.

## Requirements

- Run only inside a Git repository.
- Require Node.js 20 or newer.
- Require a target branch from the user or the PR context. If no target is
  known, ask; do not guess a base branch.
- Review committed branch history only. Staged, unstaged, and untracked files
  are outside the comparison.
- Capture and rendering are local. Do not make network requests.

## Workflow

Resolve this skill directory and use its plugin root for all script paths.

1. Create a unique temporary working directory under
   `/tmp/human-friendly-diff/work/`.
2. Resolve the target branch and run:

   ```sh
   node <plugin-root>/scripts/capture.mjs \
     --repo "$PWD" \
     --base <target-branch> \
     --output <work-dir>/capture.json
   ```

3. If capture reports no branch changes, tell the user and stop. Do not
   generate an empty report.
4. Read `capture.json`. Selectively inspect changed files, directly referenced
   symbols, nearby tests, and project/domain guidance when useful. Keep this
   inspection read-only and relevance-driven.
5. Produce `<work-dir>/analysis.json` following
   `<plugin-root>/docs/annotation-schema.md`.
   - Infer functional modules more granularly than projects or packages.
   - Build system stories ordered by runtime or causal flow.
   - Make every story beat one actor action and outcome supported by exact code excerpts.
   - Select only the relevant line range from a hunk; repeat excerpts when they explain multiple beats.
   - Reference every captured hunk at least once. Put non-narrative changes in Supporting changes.
   - Keep tests and docs with the behavior they support, while retaining their line categories on the overview.
   - Add risks and questions to the story where they matter.
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

- Never omit or reconstruct captured branch-diff content.
- If context limits prevent confident storytelling, classify what you can and
  leave the rest unassigned. The renderer places it in `Supporting changes`.
- If analysis JSON is incomplete, still render; the renderer safely repairs module and story coverage.
- Do not run tests or mutate the reviewed repository as part of report
  generation.
