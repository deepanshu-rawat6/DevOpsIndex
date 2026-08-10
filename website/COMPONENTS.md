# Interactive components

> To apply this pattern to a guide (new or existing) with the same
> conventions used throughout this repo, use the `/interactive-docs` Claude
> Code skill (`.claude/skills/interactive-docs/SKILL.md`) rather than
> reinventing the checklist each time.

The markdown pipeline (`src/lib/renderMd.ts` → `Fragment set:html={html}` in
`src/pages/topic/[...slug].astro`) passes raw HTML straight through. That means
any topic `.md` file can drop in the snippets below and get a working
interactive widget on the live site — no per-page `<script>` needed. Wiring
lives once, site-wide, in `src/layouts/BaseLayout.astro` (`initQuizzes`,
`initTabGroups`, `initSteppers`, `initToggles`), styles in
`src/styles/global.css`.

Use these to replace "wall of prose" sections with something a reader has to
click through — spaced-repetition-style checks, side-by-side comparisons, and
diagrams that reveal state one step at a time instead of all at once.

## 1. Quiz / knowledge-check

Drop one after any section where a reader should self-test before moving on.

```html
<div class="quiz-card">
  <p class="quiz-q">What's the difference between a partition being under-replicated vs offline?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Under-replicated: the leader is still up and serving traffic, but at least
    one follower has fallen behind — degraded, not down.
    Offline: there's no leader at all — the partition can't serve a single
    read or write until one comes back.
  </div>
</div>
```

Optional progress pill — put **one** of these near the top of the page (after
the intro, before Chapter 1). It auto-counts every `.quiz-card` on the page:

```html
<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>
```

## 2. Tabs

For side-by-side variants of the same idea — config flavors, language
examples, "here's the same request under acks=0 vs acks=all."

```html
<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="acks0" class="active">acks=0</button>
    <button data-tab="acks1">acks=1</button>
    <button data-tab="acksall">acks=all</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="acks0">
      Fire and forget. Fastest, data loss possible if the leader never got it.
    </div>
    <div class="tab-panel" data-tab-panel="acks1">
      Leader confirmed only. A crash before followers replicate loses the record.
    </div>
    <div class="tab-panel" data-tab-panel="acksall">
      Every ISR replica confirmed. Zero data loss, higher latency.
    </div>
  </div>
</div>
```

Rules: exactly one button needs `class="active"` and the matching panel needs
`class="tab-panel active"` — that's the initial state before JS runs.
`data-tab` on the button must match `data-tab-panel` on its panel.

## 3. Stepper / walkthrough

For a process that unfolds over time — rebalances, leader election, a TCP
handshake — where showing every step at once is more confusing than showing
one at a time. Panels can contain anything, including a Mermaid diagram or
`<pre>` block, so you can swap the whole diagram per step.

```html
<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Stable.</strong> Consumer A holds all 3 partitions. Consumer B
      is not in the group yet.
    </div>
    <div class="stepper-panel">
      <strong>2. Consumer B joins.</strong> It sends <code>JoinGroup</code> to
      the coordinator, which immediately kicks every existing member back into
      <code>PreparingRebalance</code>.
    </div>
    <div class="stepper-panel">
      <strong>3. Reassignment.</strong> Once everyone's re-checked in, the
      round's leader runs the partition assignor and both consumers get their
      new assignment via <code>SyncGroup</code>.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>
```

Rules: exactly the first `.stepper-panel` needs `class="stepper-panel active"`
in the raw markup — JS builds the dots and wires prev/next on load. Any number
of panels works.

## 4. Toggle / compare switch

For "same diagram, different state" — a system that has 2–4 discrete named
states and you want the reader flipping between them rather than reading three
separate diagrams top to bottom. Use `state-ok` / `state-warn` / `state-bad`
on the button to color it green/amber/red when active (omit for a neutral
blue).

```html
<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="healthy" class="active state-ok">Healthy</button>
    <button data-toggle-opt="under" class="state-warn">Under-replicated</button>
    <button data-toggle-opt="offline" class="state-bad">Offline</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="healthy">
    ISR = full replica set. All copies caught up.
  </div>
  <div class="toggle-panel" data-toggle-panel="under">
    ISR &lt; replicas. Leader still serving traffic, but you're one more
    failure from unavailability.
  </div>
  <div class="toggle-panel" data-toggle-panel="offline">
    No leader at all. Zero reads or writes served until a replica comes back.
  </div>
</div>
```

Rules: same active/matching-data-attribute convention as tabs.

## Diagrams: prefer Mermaid over ASCII art

The site already renders ` ```mermaid ` fences client-side (`BaseLayout.astro`
→ `renderMermaid()`), dark-themed. ASCII-art diagrams in code fences don't
reflow, don't highlight, and read worse on mobile — convert them to Mermaid
`graph`/`sequenceDiagram`/`stateDiagram-v2` blocks wherever the shape is more
than a couple of boxes and arrows. Keep ASCII only for genuinely
character-grid content (byte layouts, terminal output).

`scripts/sync-content.js`'s `fixMermaid()` auto-patches a few v11
incompatibilities (`<br>` → `<br/>`, bare `{}`/`[]` labels containing special
chars get quoted, `rx:` stripped from `classDef`) — write normal Mermaid and
don't hand-roll workarounds for those specific cases **when using a ` ```mermaid `
fence** (i.e. anywhere outside an interactive component).

**Exception — Mermaid inside a stepper/toggle/tab panel:** remark treats an
HTML block as raw and passes its contents straight through, so a ` ```mermaid `
fence *inside* one of these `<div>`s is never parsed as a fence — it renders as
literal text. Write it as `<pre><code class="language-mermaid">...</code></pre>`
directly instead (the client-side `renderMermaid()` picks up any
`pre > code.language-mermaid`, not just ones that came from a fence), and
hand-apply the same v11-safe rules `fixMermaid()` would have applied: quote
bracket/paren labels that contain special characters (`["like (this)"]`), and
don't pass `rx:` to `classDef`.

**Do NOT use `<br/>` for line breaks in a node label here.** A ` ```mermaid `
fence's content is HTML-escaped text, so a literal `<br/>` inside it survives
as text and Mermaid renders it as a line break. But `<pre><code>` written as
raw HTML (this exception case) is real markup — the browser parses `<br/>`
into an actual `<br>` element *inside* the `<code>` tag, and `.textContent`
(what `renderMermaid()` reads) silently drops element nodes, deleting the
break entirely and often mashing the two lines together with no separator.
Keep labels on one line, or split into two edges/nodes, instead.

## Authoring checklist

- Keep components inside a single top-level `<div>` — remark's raw-HTML
  passthrough is per-block; don't split a component's opening/closing tags
  across separate markdown paragraphs with blank lines in between, or across
  a code fence.
- Leave a blank line before and after the block so remark treats it as its
  own HTML block rather than trying to parse its contents as markdown.
- Everything inside a panel/answer is raw HTML, not markdown — use `<code>`,
  `<strong>`, `<br/>` etc., not backticks or `**bold**`.
- Don't nest one interactive component inside another.
