---
name: human-friendly-diff
description: Generate and open a self-contained slide presentation comparing the current Git branch against a target branch. It uses staged discovery, per-story subagents, and independent validation to organize exact diff excerpts into functional modules and chronological system stories. Use for PR-style diffs, semantic diffs, story-driven diffs, or easier branch-review.
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
   `/tmp/human-friendly-diff/work/`. Resolve the target branch and run:

   ```sh
   node <plugin-root>/scripts/capture.mjs \
     --repo "$PWD" \
     --base <target-branch> \
     --output <work-dir>/capture.json
   ```

2. If capture reports no branch changes, tell the user and stop. Do not
   generate an empty report.

3. **Discovery pass — primary agent.** Read `capture.json`. Selectively
   inspect changed files, directly referenced symbols, nearby tests, and
   project/domain guidance when useful. Write `<work-dir>/discovery.json`:

   ```json
   {
     "modules": [{ "id": "payment", "name": "Payment module", "summary": "...", "hunkIds": ["..."] }],
     "stories": [{ "id": "submit-payment", "title": "Customer submits payment", "goal": "...", "hunkIds": ["..."] }],
     "unresolved": [{ "hunkId": "...", "reason": "The code establishes a dependency, but its product intent cannot be inferred from this diff." }]
   }
   ```

   - Infer functional modules more granularly than projects or packages.
   - Identify only concrete, causally coherent stories. A story must name a
     specific actor/behavior, not a review bucket.
   - Do not create final presentation stories in this pass.
   - Do not use generic labels such as `Supporting changes`, `Miscellaneous`,
     `Other changes`, or `No user story`. If intent cannot be inferred, record
     the exact hunk with a precise explanation of what the available evidence
     does and does not establish.

4. **Story assembly — one subagent per discovered story.** Spawn one subagent
   for every item in `discovery.json.stories`. Give it `capture.json`, that
   story's discovery record, and the relevant module records. Its sole task is
   to write `<work-dir>/stories/<story-id>.json`, one analysis-schema story:

   - Assemble only the exact hunks and line ranges that support the story.
   - Arrange beats in runtime or causal order. Each beat names one actor,
     action, and outcome.
   - It may repeat a hunk when that is necessary to explain multiple beats.
   - It must say when a proposed association cannot be supported and leave the
     hunk for validation rather than broadening the story.
   - It must not run tests, mutate the reviewed repository, or invent a
     catch-all story.

5. **Validation pass — new independent subagent.** After every story result
   is available, give a fresh subagent `capture.json`, `discovery.json`, and
   all story result files. Ask it to write `<work-dir>/validation.json` that:

   - checks every concrete discovered story is represented;
   - checks each excerpt actually supports its claimed story beat;
   - identifies missing hunks, missing story beats, and unsupported inferences;
   - returns accepted stories plus `unresolved` records for every hunk that
     cannot safely belong to a concrete story.

   Reject generic titles, actions, outcomes, modules, and reasons. The
   validator must never repair gaps by creating a catch-all `No user story` or
   similar story. An unassignable hunk remains an explicit unresolved finding.

6. **Synthesis — primary agent.** Produce `<work-dir>/analysis.json` from the
   validator's accepted stories and findings, following
   `<plugin-root>/docs/annotation-schema.md`.

   - Every hunk must be either referenced by a concrete story excerpt or occur
     once in `unresolved` with an evidence-based reason.
   - Keep tests and docs with the behavior they support, while retaining their
     line categories on the overview.
   - Add risks and questions to the concrete story where they matter.
   - Report only verification actually observed in this agent session.

7. Render and launch:

   ```sh
   node <plugin-root>/scripts/render.mjs \
     --capture <work-dir>/capture.json \
     --analysis <work-dir>/analysis.json \
     --open
   ```

8. Return the generated absolute HTML path. Browser launch failure is not
   report generation failure.

## Failure behavior

- Never omit or reconstruct captured branch-diff content.
- If context limits prevent confident storytelling, record the affected hunks
  as explicit unresolved findings. The renderer shows those findings outside
  the system-story sequence; it does not create a generic story for them.
- If analysis JSON is incomplete, still render; uncovered hunks become
  explicit unresolved findings with a clear default explanation.
- Do not run tests or mutate the reviewed repository as part of report
  generation.
