---
name: human-friendly-diff
description: Generate and open a self-contained slide presentation of the current Git working tree, organizing exact diff excerpts into functional modules and chronological system stories. Use when the user asks for a human-friendly diff, semantic diff, story-driven diff, or easier review of agent-generated changes.
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

- Never omit or reconstruct captured diff content.
- If context limits prevent confident storytelling, classify what you can and
  leave the rest unassigned. The renderer places it in `Supporting changes`.
- If analysis JSON is incomplete, still render; the renderer safely repairs module and story coverage.
- Do not run tests or mutate the reviewed repository as part of report
  generation.
