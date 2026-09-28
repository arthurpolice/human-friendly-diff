# Human-Friendly Diff

Human-Friendly Diff turns a Git working-tree snapshot into a presentation that follows the behavior changed in the system.

## Language

**Change line**:
An added or deleted line in the captured Git snapshot. Change lines are classified as production, test, or other.
_Avoid_: LOC, code line

**Functional module**:
A cohesive product or system capability inferred from paths, symbols, project guidance, and call relationships. It is finer-grained than a repository or deployable project.
_Avoid_: Project, package, folder

**System story**:
An ordered narrative explaining how actors and systems participate in changed behavior.
_Avoid_: Intent group, user story

**Story beat**:
One actor action and its outcome within a system story, supported by one or more code excerpts.
_Avoid_: Step, hunk group

**Code excerpt**:
A relevant contiguous portion of a captured diff hunk. An excerpt may appear in multiple story beats.
_Avoid_: File, diff

**Coverage**:
The canonical accounting that ensures every captured hunk remains reachable from at least one story beat, independent of repeated presentation references.
