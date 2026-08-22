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

**Never put a literal `;` inside a sequenceDiagram message or Note.** Mermaid's
sequence-diagram grammar treats `;` as a statement separator (it's how you
chain multiple arrows on one line), not as literal text — so
`A->>B: BEGIN; UPDATE x; COMMIT;` fails to parse ("Syntax error in text") the
moment it hits the first semicolon, because whatever follows isn't a new
valid arrow statement. This bites SQL-transaction examples especially often.
Rewrite with commas or `then` instead: `A->>B: BEGIN, UPDATE x, COMMIT`.

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

**Never leave a blank line inside a raw `<pre><code class="language-mermaid">` block — this is the single most dangerous mistake possible here.**
A blank line is exactly how CommonMark decides an HTML block has *ended*. If one
appears between, say, your `participant` declarations and your first message
line (a common stylistic habit carried over from normal ` ```mermaid ` fences,
where blank lines are harmless), remark closes the raw-HTML block right there
— *before* your real `</code></pre>`. Everything after that point, including
sibling `<div>`s for other tabs/panels later in the same component, gets
swallowed as plain paragraph text and HTML-escaped rather than parsed as
markup. The visible symptom is a "Syntax error in text" on what looks like a
totally different, unrelated diagram further down the page, plus other tabs
in the same component silently failing to switch (their real `<div>` never
made it into the DOM — it's inert escaped text sitting inside the first
panel's code block instead). Keep every line inside one of these blocks
non-blank, always, no exceptions.

**Do NOT use `<br/>` for line breaks in a node label here.** A ` ```mermaid `
fence's content is HTML-escaped text, so a literal `<br/>` inside it survives
as text and Mermaid renders it as a line break. But `<pre><code>` written as
raw HTML (this exception case) is real markup — the browser parses `<br/>`
into an actual `<br>` element *inside* the `<code>` tag, and `.textContent`
(what `renderMermaid()` reads) silently drops element nodes, deleting the
break entirely and often mashing the two lines together with no separator.
Keep labels on one line, or split into two edges/nodes, instead.

## 5. Structure visualizer (live insert / delete / search)

For data structures where the point is *watching it reshape as you operate
on it* — a B-tree splitting on insert, a skip list's search path dropping
levels, a consistent-hashing ring rebalancing when a node joins. This is
different from the four components above: there's no shared JS wiring in
`BaseLayout.astro` for it, because the actual insert/delete/search logic is
different for every structure. Each instance is fully self-contained —
markup plus its own `<script>` — and draws into an SVG using the shared
`.viz-*` CSS classes (`global.css`) so every instance still looks and feels
consistent.

```html
<div class="structure-viz" id="lru-demo">
  <svg class="viz-canvas" viewBox="0 0 640 160"></svg>
  <div class="viz-controls">
    <input class="viz-input" type="number" placeholder="key" />
    <button class="viz-btn" data-viz-action="insert">Insert</button>
    <button class="viz-btn" data-viz-action="search">Search</button>
    <button class="viz-btn viz-btn-danger" data-viz-action="delete">Delete</button>
    <button class="viz-btn" data-viz-action="reset">Reset</button>
  </div>
  <div class="viz-status"></div>
</div>

<script>
(function () {
  const svgNS = 'http://www.w3.org/2000/svg';
  const root = document.getElementById('lru-demo');
  const svg = root.querySelector('.viz-canvas');
  const status = root.querySelector('.viz-status');
  let state = []; // whatever shape this structure needs

  function draw() {
    svg.innerHTML = '';
    state.forEach((val, i) => {
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('cx', 40 + i * 70);
      c.setAttribute('cy', 80);
      c.setAttribute('r', 22);
      c.setAttribute('class', 'viz-node');
      svg.appendChild(c);
      const t = document.createElementNS(svgNS, 'text');
      t.setAttribute('x', 40 + i * 70);
      t.setAttribute('y', 80);
      t.textContent = val;
      svg.appendChild(t);
    });
  }

  root.querySelector('[data-viz-action="insert"]').addEventListener('click', () => {
    const input = root.querySelector('.viz-input');
    const v = input.value.trim();
    if (!v) { status.textContent = 'Enter a value first.'; status.className = 'viz-status viz-status-error'; return; }
    state.push(v);
    input.value = '';
    status.textContent = `Inserted ${v}.`;
    status.className = 'viz-status viz-status-ok';
    draw();
  });

  root.querySelector('[data-viz-action="reset"]').addEventListener('click', () => {
    state = [];
    status.textContent = 'Reset.';
    status.className = 'viz-status';
    draw();
  });

  draw();
})();
</script>
```

This toy example only shows the shape of the pattern — the real per-structure
logic (a B-tree's split-on-overflow, a skip list's randomized-level search,
a hash ring's clockwise-nearest-node lookup) is bespoke to that structure and
belongs entirely inside that file's own `<script>`. Six reference
implementations exist, each demonstrating a different layout/interaction
shape — study whichever is closest to what you're building rather than
starting from the toy example above:

- `coding-practice/btree.md` — tree layout (BFS levels, leaf-order x-positioning,
  parent centered over children), split/merge narrated in the status line.
- `coding-practice/skip-list.md` — multi-row layout with a node's height drawn
  as a dashed vertical span across the rows it appears on.
- `coding-practice/lru-cache.md` — fixed-slot linear layout (simplest shape;
  good starting point for a structure with a hard capacity).
- `coding-practice/consistent-hashing.md` — actual circular SVG layout via
  trig (`cx + r*cos(angle)`), for anything ring-shaped.
- `coding-practice/bloom-filter.md` — flat bit-array with per-bit
  "contributor" tracking purely for narration (the real structure doesn't
  track this — it's added only to make the status messages teach the
  false-positive mechanism).
- `coding-practice/rate-limiter-implementations.md` — the one non-discrete
  example: a continuously-refilling gauge driven by the real wall clock
  (`Date.now()` + `setInterval`), for anything that evolves over time rather
  than on discrete operations alone.

Every one of these was built the same way — and any new one should be too:
1. Write the core logic (no DOM) as a standalone script first.
2. Test it headlessly: reproduce the file's own worked example/stepper
   scenario exactly, then run a randomized stress test (tens of runs, each
   hundreds of operations) asserting the structure's real invariants after
   every single operation (sorted order, size bounds, no orphaned pointers,
   whatever applies) — not just "it didn't throw."
3. Only after that passes, add the SVG drawing and event wiring, and smoke-test
   the DOM/interaction behavior with `jsdom` (`runScripts: 'dangerously'`)
   before ever pasting it into the markdown file.
A structure-viz that merely *looks* plausible but was never actually tested
against the algorithm it claims to demonstrate is worse than no visualizer at
all — a reader will trust the wrong belief it's animating.

**Rules specific to this component:**
- Give the `.structure-viz` div a **unique `id`** per instance on the page —
  the script looks itself up by that id, and ids must be unique in HTML
  regardless.
- **Put the `<script>` as a sibling immediately after the closing
  `</div>`, never nested inside it.** This isn't a style preference — it's
  load-bearing. A `<script>` tag is itself a CommonMark "type 1" raw HTML
  block, terminated only by its literal `</script>` closing tag, so blank
  lines anywhere inside it are completely safe. But if you nest that same
  `<script>` inside the `.structure-viz` `<div>` (a "type 6" block), the
  *div's* blank-line-termination rule applies to everything inside it,
  including your script — one blank line in your JS (normal, idiomatic
  formatting) would silently truncate the whole component early, the same
  failure mode documented above for `<pre><code>`. Keeping the script as a
  top-level sibling sidesteps the whole hazard: write your JS however you
  normally would, blank lines included.
- Use the shared classes for anything drawn into the SVG so it matches the
  rest of the site: `.viz-node` (default), `.viz-node-new` (just inserted),
  `.viz-node-highlight` (currently being searched/traversed),
  `.viz-node-removing` (mid-delete), `.viz-edge` / `.viz-edge-active` for
  connecting lines, plain `<text>` for labels (already styled).
- Always re-render by clearing and redrawing the whole SVG on every
  operation (`svg.innerHTML = ''` then rebuild) rather than trying to
  incrementally patch DOM nodes — these structures are small enough that a
  full redraw is cheap, and it eliminates an entire class of "stale node
  left behind" bugs.
- Give the user feedback in `.viz-status` for every action, including
  failure cases ("not found", "already exists", "enter a value first") —
  a visualizer that silently does nothing on a bad input feels broken.
- This component is for *manipulable* structures — trees, lists, rings,
  bit arrays, hash tables. It is not a replacement for `stepper` (a fixed,
  authored narrative works better as a stepper) — use a structure-viz when
  the reader should be able to try their *own* values, not just watch one
  scripted sequence.

## Authoring checklist

- Keep components inside a single top-level `<div>` — remark's raw-HTML
  passthrough is per-block; don't split a component's opening/closing tags
  across separate markdown paragraphs with blank lines in between, or across
  a code fence.
- Leave a blank line before and after the block so remark treats it as its
  own HTML block rather than trying to parse its contents as markdown.
- Everything inside a panel/answer is raw HTML, not markdown — use `<code>`,
  `<strong>`, `<br/>` etc., not backticks or `**bold**`.
- Don't nest one interactive component inside another (the structure-viz's
  own `<script>` sibling is the one deliberate exception to "inside a single
  top-level div" — see its rule above for why).
