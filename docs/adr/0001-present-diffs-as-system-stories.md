# Present diffs as system stories

Human-Friendly Diff will organize pull-request-style branch comparisons as a slide presentation: an overview first explains change-line composition and functional modules, then ordered system stories connect actor actions to reusable code excerpts. The comparison runs from the target branch's merge base to the current branch `HEAD`, excluding working-tree state. Canonical hunk coverage remains separate from presentation references so chronology can drive the review without losing changed lines, while exact excerpts may recur wherever they explain multiple beats.

Story construction is staged: a primary agent discovers concrete modules and
stories, a separate subagent assembles each story, and a fresh validator checks
the result against the capture. A hunk that cannot be supported by a specific
story is an explicit unresolved finding; generic catch-all stories are
prohibited.
