# Presentation analysis schema

The renderer accepts `human-friendly-diff.analysis/v3`. Capture IDs and line
positions are the only references to source content; the renderer always uses
the exact captured diff.

```json
{
  "schemaVersion": "human-friendly-diff.analysis/v3",
  "overview": {
    "modules": [{
      "id": "payments",
      "name": "Payment module",
      "summary": "Authorizes and records charges.",
      "hunkIds": ["src/payments.js::0"],
      "secondaryHunkIds": ["src/checkout.js::0"]
    }]
  },
  "stories": [{
    "id": "submit-order",
    "title": "Customer submits an order",
    "goal": "Carry a valid order from the form to payment authorization.",
    "summary": "Optional story context.",
    "attention": "review-carefully",
    "attentionReason": "Touches payment authorization.",
    "confidence": "high",
    "risks": ["A retry could submit twice."],
    "questions": ["Is the request idempotent?"],
    "steps": [{
      "id": "form-submit",
      "actor": "Customer",
      "action": "Submits the checkout form",
      "outcome": "The application constructs a payment request.",
      "moduleId": "checkout",
      "excerpts": [{
        "hunkId": "src/checkout.js::0",
        "lineStart": 2,
        "lineEnd": 8,
        "explanation": "Validates the form and creates the request."
      }]
    }]
  }],
  "unresolved": [{
    "hunkId": "src/bootstrap.js::0",
    "reason": "The diff registers a dependency, but its product intent cannot be inferred from the captured code."
  }],
  "verification": [{ "command": "npm test", "status": "passed", "note": "Observed in this session" }]
}
```

## Rules

- Infer functional modules from paths, symbols, project language, and call
  relationships—not merely repository or package names.
- Give each hunk one primary module through `hunkIds`.
  `secondaryHunkIds` may overlap.
- Order stories and beats by runtime or causal flow, not review severity. A
  story must describe a specific behavior, never a catch-all review bucket.
- A beat describes one actor action and outcome. Actors may be people, internal
  components, schedulers, or external systems.
- `lineStart` and `lineEnd` are inclusive, one-based positions in the
  captured hunk's `lines` array. Select only the portion relevant to the beat.
- The same excerpt may appear in multiple beats. Repetition is presentation; it
  does not alter canonical coverage.
- Every hunk must be referenced by at least one concrete story excerpt **or**
  appear exactly once in `unresolved`. An unresolved finding is validation
  evidence, not a story or a module.
- An unresolved reason states the inference boundary: what the code shows and
  what cannot be determined. Do not use vague labels or invent intent.
- Never create `Supporting changes`, `Miscellaneous`, `Other changes`,
  `No user story`, or equivalent generic stories.
- `attention` is `routine`, `review-carefully`, or `critical`.
  `confidence` is `high`, `medium`, or `low`.
- Verification may report only commands observed in the active agent session.
