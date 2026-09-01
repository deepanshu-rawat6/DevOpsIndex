# BGP — How the Internet Actually Routes Between Networks

`osi-model.md` and `tcp-udp.md` both assume something this file doesn't: that once a packet knows its destination IP, the network already knows how to get it there. It doesn't, not automatically. The internet is not one network with a master routing table — it's tens of thousands of independently operated networks that have to tell each other, continuously, "here's what I can reach." BGP (Border Gateway Protocol) is the protocol running between every one of them that makes that reachability exist at all.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. Autonomous Systems — The Actual Unit of the Internet

An **Autonomous System (AS)** is a network under one administrative control — an ISP, a cloud provider, a large company running its own backbone — identified by a globally unique **ASN** (e.g. `AS15169` for Google). The internet isn't a single network at all; it's a mesh of 70,000+ ASes, each one announcing to its neighboring ASes which IP prefixes it owns or can reach. Nobody outside an AS's own operators decides what that AS announces, and nobody inside it needs to understand the topology of any other AS to make routing work.

That last point is the actual reason this unit exists: no single entity could — or should — own global routing. An AS only ever needs two things to route correctly: knowledge of what it itself can reach, and the advertisements its immediate neighbors hand it. Global reachability emerges from tens of thousands of these local, bilateral exchanges, not from any one party holding the whole map.

<div class="quiz-card">
  <p class="quiz-q">Why does the internet need the AS as a unit at all — why not just have every router everywhere exchange routes directly?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Because no single entity could or should own global routing knowledge. The AS boundary means each network only has to know its own internal reachability plus whatever its neighboring ASes advertise to it — not the topology of the entire internet. Global reachability is an emergent property of tens of thousands of these local, bilateral relationships, which is exactly what lets the internet keep growing without any one party needing a complete picture of it.</div>
</div>

---

## 2. Path-Vector Routing — How BGP Decides a Route

BGP is a **path-vector** protocol, not a distance-vector or link-state one. The distinction matters: a link-state protocol (OSPF, IS-IS) floods full topology and computes shortest paths by cost; a distance-vector protocol just exchanges a hop count. BGP instead has every router advertise the **entire AS-path** a route traversed — the ordered list of every AS it passed through to reach the origin. That single design choice is also what makes BGP's loop prevention trivial: if a router receives an advertisement whose AS-path already contains its own ASN, it just discards it. No loop-detection algorithm, no sequence numbers, no separate mechanism — the evidence of the loop is sitting right there in the path itself.

When multiple routes exist to the same prefix, BGP picks one route using an ordered list of tiebreakers — the full list is longer than this, but three come up constantly in practice:

1. **Highest LOCAL_PREF** — an operator's own policy preference for a route. It's set locally and never leaves the AS it was set in; it exists purely to let an operator say "prefer this path" regardless of what the path itself looks like.
2. **Shortest AS-PATH** — fewer AS hops wins, but this is a **policy tiebreaker, not a true cost metric** the way OSPF/IS-IS link cost is. A 2-hop path through two congested, oversubscribed networks can still lose to a longer path if LOCAL_PREF says so — AS-PATH length only gets consulted once LOCAL_PREF didn't decide the outcome.
3. **Lowest MED** (Multi-Exit Discriminator) — a hint one neighboring AS gives about which of *its own* multiple entry points it'd prefer you use. MED is only ever compared between routes learned from the *same* neighboring AS — it says nothing across unrelated neighbors.

After that: eBGP-learned routes beat iBGP-learned ones, then lowest IGP metric to the next hop, then several more deterministic tiebreakers (oldest route, lowest router ID, etc.) that exist purely to guarantee every router converges on the same single winner even when everything above is tied.

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Origin announces.</strong> AS 65001 owns <code>203.0.113.0/24</code> and announces it to both of its upstream neighbors, AS 65010 and AS 65030. Each advertisement's AS-path is just <code>65001</code> so far.
    </div>
    <div class="stepper-panel">
      <strong>2. Neighbors propagate, path grows by one hop each time.</strong> AS 65010 re-advertises toward AS 65099 with AS-path <code>65010, 65001</code>. AS 65030 re-advertises toward AS 65020 with AS-path <code>65030, 65001</code>, and AS 65020 in turn re-advertises toward AS 65099 with AS-path <code>65020, 65030, 65001</code> — every hop prepends itself before passing the route on.
    </div>
    <div class="stepper-panel">
      <strong>3. Downstream AS receives both paths.</strong> AS 65099 now has two candidate routes to <code>203.0.113.0/24</code>: a 2-AS path via AS 65010, and a 3-AS path via AS 65020 → AS 65030.
    </div>
    <div class="stepper-panel">
      <strong>4. LOCAL_PREF checked first.</strong> AS 65099 has no LOCAL_PREF configured for either route, so both are equal on this criterion and the decision falls through to the next tiebreaker.
    </div>
    <div class="stepper-panel">
      <strong>5. AS-PATH length compared.</strong> The path via AS 65010 has 2 ASes; the path via AS 65020 → AS 65030 has 3. AS 65099 picks the shorter one — the route via AS 65010.
    </div>
    <div class="stepper-panel">
      <strong>6. Installed and re-advertised further downstream.</strong> AS 65099 installs the AS 65010 route and, if it re-announces it to its own downstream neighbors, prepends itself: the AS-path they'll see is <code>65099, 65010, 65001</code>.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

```mermaid
flowchart TD
    classDef origin fill:#c0392b,stroke:#922b21,color:#fff,rx:6
    classDef transit fill:#2980b9,stroke:#1f618d,color:#fff,rx:6
    classDef decision fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6

    X["AS 65001 — origin<br/>announces 203.0.113.0/24"]:::origin

    X -->|"AS-PATH: 65001"| A["AS 65010"]:::transit
    X -->|"AS-PATH: 65001"| C["AS 65030"]:::transit

    A -->|"AS-PATH: 65010, 65001<br/>2 ASes"| D["AS 65099 — downstream<br/>compares both candidate routes"]:::decision
    C -->|"AS-PATH: 65030, 65001"| B["AS 65020"]:::transit
    B -->|"AS-PATH: 65020, 65030, 65001<br/>3 ASes"| D
```

<div class="quiz-card">
  <p class="quiz-q">A router receives a BGP advertisement whose AS-path already contains its own ASN. What does it do, and why doesn't it need a separate loop-detection algorithm to know to do it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>It discards the advertisement immediately. Because BGP is path-vector — every advertisement carries the full ordered list of ASes it already traversed, not just a hop count — the evidence that accepting this route would create a loop is sitting directly in the path itself. Seeing its own ASN there is proof positive a loop exists, so a simple membership check replaces what a distance-vector or link-state protocol would need a dedicated loop-detection mechanism for.</div>
</div>

The stepper above only ever shows one scenario: two routes tied on LOCAL_PREF, decided by AS-PATH length. The tiebreaker cascade goes further than that, and two of its rules are easy to get wrong — MED is only ever compared between routes learned from the *same* neighboring AS, never across unrelated neighbors, and eBGP-learned routes beat iBGP-learned ones after MED. Add your own candidate routes below and recompute to see the full cascade run in order: highest LOCAL_PREF → shortest AS-PATH → lowest MED (same neighbor AS only) → eBGP over iBGP → lowest router ID as the tiebreak of last resort.

<div class="structure-viz" id="bgp-bestpath-demo">
  <svg class="viz-canvas" viewBox="0 0 660 130"></svg>
  <div class="viz-controls">
    <input class="viz-input" data-field="label" type="text" placeholder="label (optional)" style="width:9rem" />
    <input class="viz-input" data-field="localpref" type="number" placeholder="LOCAL_PREF (100)" style="width:8.5rem" />
    <input class="viz-input" data-field="aspath" type="text" placeholder="AS-PATH e.g. 65010,65001" style="width:11rem" />
    <input class="viz-input" data-field="med" type="number" placeholder="MED (0)" style="width:6rem" />
    <select class="viz-input" data-field="session" style="width:6rem">
      <option value="eBGP">eBGP</option>
      <option value="iBGP">iBGP</option>
    </select>
    <button class="viz-btn" data-viz-action="add">Add route</button>
    <button class="viz-btn" data-viz-action="recompute">Recompute best path</button>
    <button class="viz-btn viz-btn-danger" data-viz-action="reset">Reset</button>
  </div>
  <div class="viz-status"></div>
  <div class="viz-legend">
    <span><span class="viz-swatch" style="background:#1e3a8a"></span> candidate route</span>
    <span><span class="viz-swatch" style="background:#78350f"></span> current best path</span>
    <span>Click the small &times; on a card to remove that route.</span>
  </div>
</div>

<script>
(function () {
  var svgNS = 'http://www.w3.org/2000/svg';
  var root = document.getElementById('bgp-bestpath-demo');
  var svg = root.querySelector('.viz-canvas');
  var status = root.querySelector('.viz-status');
  var labelInput = root.querySelector('[data-field="label"]');
  var lpInput = root.querySelector('[data-field="localpref"]');
  var pathInput = root.querySelector('[data-field="aspath"]');
  var medInput = root.querySelector('[data-field="med"]');
  var sessionInput = root.querySelector('[data-field="session"]');

  var routes = [];
  var nextId = 1;
  var winnerId = null;

  // ---- pure, testable comparator logic --------------------------------
  function parseAsPath(str) {
    return str.split(/[,\s]+/).map(function (s) { return s.trim(); }).filter(Boolean).map(Number);
  }

  function narrowByLocalPref(rs) {
    var max = Math.max.apply(null, rs.map(function (r) { return r.localPref; }));
    return rs.filter(function (r) { return r.localPref === max; });
  }
  function narrowByAsPathLength(rs) {
    var min = Math.min.apply(null, rs.map(function (r) { return r.asPath.length; }));
    return rs.filter(function (r) { return r.asPath.length === min; });
  }
  function narrowByMed(rs) {
    // MED is only ever compared between routes learned from the SAME neighboring AS.
    var groups = {};
    rs.forEach(function (r) {
      var key = String(r.asPath[0]);
      (groups[key] = groups[key] || []).push(r);
    });
    var survivors = [];
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      var min = Math.min.apply(null, group.map(function (r) { return r.med; }));
      group.forEach(function (r) { if (r.med === min) survivors.push(r); });
    });
    return survivors;
  }
  function narrowByEbgpOverIbgp(rs) {
    var hasEbgp = rs.some(function (r) { return r.session === 'eBGP'; });
    if (!hasEbgp) return rs;
    return rs.filter(function (r) { return r.session === 'eBGP'; });
  }
  function narrowByRouterId(rs) {
    var min = Math.min.apply(null, rs.map(function (r) { return r.routerId; }));
    return rs.filter(function (r) { return r.routerId === min; });
  }

  var CASCADE = [
    {
      shortLabel: 'LOCAL_PREF',
      narrow: narrowByLocalPref,
      describe: function (w, c) { return w.label + "'s LOCAL_PREF (" + w.localPref + ') beats ' + c.label + "'s (" + c.localPref + ')'; }
    },
    {
      shortLabel: 'AS-PATH length',
      narrow: narrowByAsPathLength,
      describe: function (w, c) { return w.label + "'s AS-PATH is shorter (" + w.asPath.length + ' hop' + (w.asPath.length === 1 ? '' : 's') + ' vs ' + c.label + "'s " + c.asPath.length + ')'; }
    },
    {
      shortLabel: 'MED',
      narrow: narrowByMed,
      describe: function (w, c) { return w.label + ' and ' + c.label + ' are both learned from AS' + w.asPath[0] + ", and " + w.label + "'s MED (" + w.med + ') is lower than ' + c.label + "'s (" + c.med + ')'; }
    },
    {
      shortLabel: 'session type (eBGP vs iBGP)',
      narrow: narrowByEbgpOverIbgp,
      describe: function (w, c) { return w.label + ' is eBGP-learned vs ' + c.label + "'s iBGP"; }
    },
    {
      shortLabel: 'router ID',
      narrow: narrowByRouterId,
      describe: function (w, c) { return w.label + "'s router ID (" + w.routerId + ') is lower than ' + c.label + "'s (" + c.routerId + ')'; }
    }
  ];

  function selectBestPath(rs) {
    if (!rs.length) return null;
    if (rs.length === 1) return { winner: rs[0], tiedOn: [], decidedBy: null, competitor: null };
    var candidates = rs.slice();
    var tiedOn = [];
    var decidedBy = null;
    var beforeStep = candidates;
    for (var i = 0; i < CASCADE.length; i++) {
      var step = CASCADE[i];
      beforeStep = candidates;
      candidates = step.narrow(candidates);
      if (candidates.length === 1) { decidedBy = step; break; }
      tiedOn.push(step.shortLabel);
    }
    var winner = candidates[0];
    var competitor = decidedBy ? beforeStep.filter(function (r) { return r !== winner; })[0] : null;
    return { winner: winner, tiedOn: tiedOn, decidedBy: decidedBy, competitor: competitor };
  }

  function joinAnd(arr) {
    if (arr.length === 0) return '';
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return arr[0] + ' and ' + arr[1];
    return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
  }

  function buildMessage(result) {
    var winner = result.winner, tiedOn = result.tiedOn, decidedBy = result.decidedBy, competitor = result.competitor;
    if (!decidedBy) {
      if (tiedOn.length === 0) return winner.label + ' wins: it is the only candidate route.';
      return winner.label + ' wins arbitrarily — every route tied all the way down to router ID. Give routes distinct router IDs to break a real tie.';
    }
    var decisive = decidedBy.describe(winner, competitor);
    if (tiedOn.length) {
      return winner.label + ' wins: tied on ' + joinAnd(tiedOn) + ', but ' + decisive + '.';
    }
    return winner.label + ' wins: ' + decisive + '.';
  }

  // ---- rendering --------------------------------------------------------
  function computeLayout(n) {
    var cardW = 200, cardH = 118, gapX = 16, gapY = 16, padding = 14;
    var cols = Math.max(1, Math.min(3, n));
    var rows = Math.max(1, Math.ceil(n / cols));
    var width = cols * cardW + (cols - 1) * gapX + padding * 2;
    var height = rows * cardH + (rows - 1) * gapY + padding * 2;
    return { cardW: cardW, cardH: cardH, gapX: gapX, gapY: gapY, padding: padding, cols: cols, width: width, height: height };
  }

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'viz-status' + (kind === 'ok' ? ' viz-status-ok' : kind === 'error' ? ' viz-status-error' : '');
  }

  function draw() {
    var layout = computeLayout(routes.length || 1);
    svg.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (routes.length === 0) {
      var empty = document.createElementNS(svgNS, 'text');
      empty.setAttribute('x', layout.width / 2);
      empty.setAttribute('y', layout.height / 2);
      empty.setAttribute('class', 'viz-label-dim');
      empty.textContent = 'No candidate routes yet — add one below.';
      svg.appendChild(empty);
      return;
    }

    routes.forEach(function (route, i) {
      var col = i % layout.cols;
      var row = Math.floor(i / layout.cols);
      var x = layout.padding + col * (layout.cardW + layout.gapX);
      var y = layout.padding + row * (layout.cardH + layout.gapY);

      var rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', layout.cardW);
      rect.setAttribute('height', layout.cardH);
      rect.setAttribute('rx', 8);
      rect.setAttribute('class', route.id === winnerId ? 'viz-node-highlight' : 'viz-node');
      svg.appendChild(rect);

      var lines = [
        route.label,
        'LOCAL_PREF ' + route.localPref,
        'AS-PATH ' + route.asPath.join(',') + ' (' + route.asPath.length + ')',
        'MED ' + route.med + ' via AS' + route.asPath[0],
        route.session,
        'Router ID ' + route.routerId
      ];
      lines.forEach(function (line, li) {
        var t = document.createElementNS(svgNS, 'text');
        t.setAttribute('x', x + layout.cardW / 2);
        t.setAttribute('y', y + 20 + li * 17);
        if (li !== 0) t.setAttribute('class', 'viz-label-dim');
        t.textContent = line;
        svg.appendChild(t);
      });

      var delCircle = document.createElementNS(svgNS, 'circle');
      delCircle.setAttribute('cx', x + layout.cardW - 14);
      delCircle.setAttribute('cy', y + 14);
      delCircle.setAttribute('r', 9);
      delCircle.setAttribute('fill', '#7f1d1d');
      delCircle.setAttribute('stroke', '#f87171');
      delCircle.setAttribute('data-remove-id', route.id);
      delCircle.style.cursor = 'pointer';
      svg.appendChild(delCircle);

      var delText = document.createElementNS(svgNS, 'text');
      delText.setAttribute('x', x + layout.cardW - 14);
      delText.setAttribute('y', y + 14);
      delText.setAttribute('fill', '#fecaca');
      delText.setAttribute('font-size', '10');
      delText.textContent = '×';
      svg.appendChild(delText);
    });
  }

  function labelFromIndex(idx) {
    return 'Route ' + String.fromCharCode(65 + (idx % 26));
  }

  root.querySelector('[data-viz-action="add"]').addEventListener('click', function () {
    var rawPath = pathInput.value.trim();
    var asPath = parseAsPath(rawPath);
    if (!asPath.length || asPath.some(function (n) { return isNaN(n); })) {
      setStatus('AS-PATH needs at least one AS number, e.g. "65010, 65001".', 'error');
      return;
    }
    var id = nextId++;
    var label = labelInput.value.trim() || labelFromIndex(routes.length);
    var localPref = lpInput.value.trim() === '' ? 100 : Number(lpInput.value);
    var med = medInput.value.trim() === '' ? 0 : Number(medInput.value);
    var session = sessionInput.value;
    routes.push({ id: id, label: label, localPref: localPref, asPath: asPath, med: med, session: session, routerId: id });
    labelInput.value = ''; pathInput.value = ''; medInput.value = ''; lpInput.value = '';
    winnerId = null;
    setStatus(label + ' added. Click "Recompute best path" to re-run selection.', '');
    draw();
  });

  root.querySelector('[data-viz-action="recompute"]').addEventListener('click', function () {
    if (routes.length === 0) { setStatus('Add at least one candidate route first.', 'error'); return; }
    var result = selectBestPath(routes);
    winnerId = result.winner.id;
    setStatus(buildMessage(result), 'ok');
    draw();
  });

  root.querySelector('[data-viz-action="reset"]').addEventListener('click', function () {
    routes = [];
    winnerId = null;
    nextId = 1;
    setStatus('Cleared all candidate routes.', '');
    draw();
  });

  svg.addEventListener('click', function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-remove-id');
    if (id) {
      routes = routes.filter(function (r) { return r.id !== Number(id); });
      if (winnerId === Number(id)) winnerId = null;
      draw();
    }
  });

  // Seed with the file's own worked example from the stepper above, so the
  // widget starts in a familiar state before the reader explores further.
  routes.push({ id: nextId++, label: 'Route A (via AS 65010)', localPref: 100, asPath: [65010, 65001], med: 0, session: 'eBGP', routerId: 1 });
  routes.push({ id: nextId++, label: 'Route B (via AS 65020 → AS 65030)', localPref: 100, asPath: [65020, 65030, 65001], med: 0, session: 'eBGP', routerId: 2 });
  draw();
})();
</script>

Two cases worth trying that the stepper above never shows: add a third route with the *same* AS-PATH as Route A (`65010,65001`) but a higher MED — since it shares Route A's neighboring AS (65010), MED now legitimately decides between them. Then try adding a route with a *different* first AS hop (a different neighboring AS) and a much lower MED than everything else — watch it *not* win on MED, because MED is never compared across routes from different neighbors; the cascade falls through to eBGP-vs-iBGP or router ID instead.

---

## 3. Why Anycast Actually Works

`cdn.md` and `load-balancers.md` both mention anycast — CDN PoPs announcing the same IP prefix so BGP routes users to whichever is topologically nearest, and GCP's global load balancer announcing a single IP from every Google PoP worldwide. Neither file explains the mechanism, because there isn't a separate one to explain: anycast is not a distinct protocol layered on top of BGP, it's the exact same path-vector routing from section 2 above, with one twist — multiple physically distant locations announce the **identical** IP prefix as if each were the true origin.

BGP has no idea these announcements come from different data centers rather than one. It just runs its ordinary best-path selection — the same LOCAL_PREF → AS-PATH → MED sequence from section 2 — independently for every network's view of the internet. A client in Singapore and a client in Frankfurt each end up, via their own ISP's best-path decision, routed to whichever advertisement reaches them via the shortest AS-path, which in practice usually correlates with genuine geographic and network proximity. There's no anycast-aware component anywhere in this path; ordinary BGP path selection does 100% of the work.

<div class="quiz-card">
  <p class="quiz-q">Does a client need any special DNS or geo-IP logic to benefit from anycast, the way GeoDNS requires the resolver to look at the client's location?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. The client just connects to "the IP" — one single address, same for every client everywhere — and the network's ordinary BGP path selection figures out which physical location that address routes to for each requester. This is the opposite of GeoDNS, which <em>is</em> a DNS-layer trick: it hands back a different IP address depending on the resolver's location, meaning the decision happens before any packet is even sent. Anycast makes no decision at the DNS layer at all — it's purely a routing-layer mechanism, resolved after the client already has the address.</div>
</div>

---

## 4. Route Leaks and Hijacks — When BGP's Trust Model Fails

Classic BGP has essentially no built-in authentication of "does this AS actually have the right to announce this prefix." Any AS can announce any prefix, and by default its neighbors will often propagate that announcement onward without question — BGP operates on implicit trust between neighboring networks, nothing more.

Two failure modes come from this gap. A **route leak** is accidental: a customer AS, misconfigured, re-announces routes it learned from one upstream provider out to another, effectively volunteering itself as unintended transit for traffic that should never have passed through it. A **hijack** is the deliberate version — an AS announces a prefix it doesn't own, and if that announcement looks attractive enough (a shorter AS-path, say), other networks start sending it traffic meant for the real owner, which can black-hole or intercept it. These aren't hypothetical — misconfigured route leaks and outright hijacks have both, at various points, disrupted or intercepted traffic for major internet services, which is precisely why the industry built a cryptographic fix rather than continuing to rely on trust alone.

That fix is **RPKI** (Resource Public Key Infrastructure): cryptographically signed statements, issued by the legitimate holder of a prefix, of exactly which ASN is authorized to originate it. A router doing Route Origin Validation against RPKI data can reject an announcement that doesn't match — turning "we trust whatever our neighbor tells us" into "we can actually verify this."

<div class="quiz-card">
  <p class="quiz-q">Why can't a BGP router just automatically reject an obviously-wrong announcement — someone else originating your prefix — without RPKI?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Because classic BGP has no cryptographic concept of prefix ownership baked in at all — it operates purely on implicit trust between neighboring networks, where any AS is free to announce any prefix and neighbors will often propagate it. There's nothing in the protocol itself for a router to check the announcement against. RPKI is exactly what closes that gap: it gives routers a cryptographically signed record of which ASN is actually authorized to originate a given prefix, so an unauthorized announcement can be identified and rejected instead of implicitly trusted.</div>
</div>

---

## Interview Follow-Ups

**"BGP prefers a shorter AS-path — isn't that just picking the fastest route, the way OSPF cost does?"** No — AS-PATH length is a policy tiebreaker, not a true cost metric. It's only even consulted after LOCAL_PREF, an operator's own preference that never leaves their AS, is checked first and doesn't decide the outcome. A 2-hop path through two congested networks can lose to a 3-hop path if an operator's LOCAL_PREF says so; AS-PATH length says nothing about actual latency or congestion, only about how many administrative boundaries a route crosses.

**"How does anycast relate to what cdn.md and load-balancers.md already describe?"** It's not a separate mechanism at all — it's the same BGP best-path selection from section 2, just with multiple physically distant locations announcing the identical prefix instead of one. `cdn.md`'s CDN PoPs and `load-balancers.md`'s GCP global LB both rely on exactly this: ordinary BGP path selection (usually shortest AS-path) naturally routes each client to whichever advertisement is topologically nearest to them, with zero anycast-specific logic anywhere in the routing path.

**"What does RPKI actually authenticate, and what does it leave unprotected?"** RPKI authenticates prefix origin — cryptographically proving which ASN is authorized to originate a given prefix, and letting routers reject announcements that don't match. It does not validate the full AS-path a route traversed; an attacker who's legitimately authorized to originate a prefix (or who compromises a valid originator) but forges or manipulates the path itself sits outside what origin validation alone catches — that's a separate, harder problem (path validation, e.g. BGPsec) still far less deployed than RPKI is.

**"If BGP has no real authentication, why hasn't the whole internet been hijacked into uselessness?"** Mostly operational discipline rather than protocol guarantees: most networks only accept announcements from neighbors they have an actual business relationship with, filter what prefixes a given neighbor is allowed to announce, and increasingly reject anything that fails RPKI validation. The protocol itself trusts everyone; the internet stays usable because operators layer policy and, increasingly, cryptography on top of that trust rather than relying on BGP to enforce it natively.
