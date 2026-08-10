---
name: interactive-docs
description: Retrofit or author DevOpsIndex guides with the repo's standard interactive components (quiz cards, tabs, steppers, toggles) and Mermaid diagrams, following the established website/COMPONENTS.md pattern. Use when writing a new guide, or when asked to "make a doc interactive", "add quizzes", or "match the kafka-field-guide style".
---

# Interactive docs

DevOpsIndex's website (`website/`) renders every topic markdown file through a
pipeline that passes raw HTML straight through (`remark-rehype` with
`allowDangerousHtml`, rendered via `Fragment set:html`). That means any guide
can embed plain HTML snippets and get live interactivity for free — click-to-
reveal quizzes, tabs, step-through walkthroughs, compare toggles — with zero
per-page JavaScript. The wiring already exists site-wide in
`website/src/layouts/BaseLayout.astro` and `website/src/styles/global.css`.

This skill's job: apply that pattern **consistently** to a guide — new or
existing — the same way it's already been applied across `databases/`,
`kubernetes/`, `linux/`, `advanced/`, and elsewhere in this repo.

## Before touching any file

1. Read `website/COMPONENTS.md` in full. It's the source of truth for the
   exact HTML syntax, the four component types, and the authoring checklist
   (blank lines around blocks, no markdown inside raw-HTML panels, the
   `<br/>`-inside-a-raw-`<pre><code class="language-mermaid">` gotcha, etc.).
   Don't improvise syntax — copy its patterns.
2. Skim `databases/kafka-field-guide.md` as the reference implementation —
   it's the flagship example every other guide was made to match.
3. Confirm the target file is actually rendered by the website. Check
   `website/scripts/sync-content.js`'s `SECTIONS` array for the section slug.
   `go/` and `coding-practice/` are **not** currently in that list — components
   added there would be inert dead markup on GitHub (no JS engine runs them),
   so skip this skill for files in those two directories unless the site's
   `SECTIONS` list is extended to include them first.

## The standard pattern

Apply this checklist to the target file(s) — one file at a time, treating
each on its own merits rather than mechanically forcing every component type
into every file:

1. **quiz-progress pill** — exactly one per file, placed after the intro
   paragraph, before the first `##` section or first `---`.
2. **quiz-card** — one after most major `##` sections. Skip pure
   command-reference/cheat-sheet sections (a bare list of kubectl one-liners,
   a PromQL cheat sheet) where there's no single conceptual claim to test.
   Every answer must be sourced strictly from that section's own existing
   text — never invent a fact the file doesn't already state.
3. **stepper** — wherever the file describes a process that unfolds over
   time: a protocol handshake, a failure/recovery sequence, a deploy/rollout
   lifecycle, a control-loop iteration. Add it *alongside* an existing
   diagram, not as a replacement — the stepper is a "walk through it slowly"
   companion to the "see it all at once" diagram.
4. **tab-group** / **toggle-switch** — wherever the file describes 2–4
   named, comparable variants or states currently sitting in flat prose.
   Use `toggle-switch` for states of *one* system (health states, severity
   levels — color with `state-ok`/`state-warn`/`state-bad` where it fits).
   Use `tab-group` for side-by-side alternative approaches/configs that
   aren't really "states" of the same thing. **Don't force either one** where
   an existing table is genuinely the clearer format for that data (dense
   multi-attribute comparisons, 5+ options) — a quiz-card alone is fine there.
5. **ASCII → Mermaid** — convert plain-text box/arrow diagrams (more than a
   couple of connected components) into Mermaid `graph`/`sequenceDiagram`/
   `stateDiagram-v2` blocks, matching this repo's existing Mermaid style
   (dark-friendly, minimal explicit fill colors except to flag a
   failure/error state, similar node-naming to what's already in the file).
   Leave genuinely character-grid content (byte layouts, terminal output,
   numeric traces) as plain fences — that's COMPONENTS.md's stated exception.
6. **Never remove** existing explanatory prose or already-good existing
   Mermaid diagrams. This skill adds interactivity and upgrades diagrams; it
   does not shorten a guide or change its voice.
7. **Match the file's existing tone.** This repo's voice is concise,
   first-principles, "why it matters" callouts — write new quiz/component
   copy in that same register, not a generic tutorial voice.

## Self-check before finishing

Don't take the pattern on faith — verify it structurally:

- Every `tab-group`/`toggle-switch` has exactly one `active` button whose
  `data-tab`/`data-toggle-opt` matches exactly one `active` panel's
  `data-tab-panel`/`data-toggle-panel`.
- Every `quiz-card` has exactly one `quiz-reveal` button and one `quiz-a` div.
- Every `stepper`'s first (and only its first) panel carries
  `class="stepper-panel active"`.
- No markdown syntax (backticks, `**bold**`) leaked into a raw-HTML panel —
  it won't render, it'll show as literal text (remark doesn't parse markdown
  inside raw HTML blocks).
- Blank lines surround every component's top-level `<div>` so remark treats
  it as one HTML block, not scattered across markdown paragraphs.

If several files are being retrofit in one pass and it's practical, finish
with a real build check:

```
cd website && rm -rf dist src/data src/content && npm run build
```

A clean run building the expected page count with no errors is the real
confirmation — the structural self-check above catches most mistakes without
needing Node installed, but the build is the ground truth.

## When authoring a brand-new guide from scratch

Same checklist applies from the start — don't write the guide first and
bolt components on after as an afterthought. As you draft each section, ask
"does this section have one easy-to-miss idea worth a quiz?", "does this
unfold over time?", "is this 2-4 named things being compared?" — and reach
for the matching component inline, the same way `kafka-field-guide.md` does.

## Scope discipline

This skill is about *pattern consistency*, not maximalism. A short reference
file with no real conceptual content (a pure link index, a one-line
redirect) should get little or nothing — say so plainly rather than forcing
a quiz-progress pill and an empty toggle onto three lines of prose. Match the
component density to how conceptual the file actually is, the same
proportional judgment already applied across the guides in this repo.
