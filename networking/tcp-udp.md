# TCP and UDP

Both protocols move bytes over IP, but they sit at opposite ends of a tradeoff: TCP spends packets and RTTs buying reliability and ordering, UDP spends nothing and leaves those problems to the application. Everything below — handshakes, sequence numbers, congestion control — is a consequence of that one choice. Track how many of the checks below you can answer before revealing:

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

## TCP — Transmission Control Protocol

TCP provides **reliable, ordered, error-checked** delivery of a byte stream between two endpoints. It guarantees every byte arrives exactly once and in order.

### 3-Way Handshake

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: Connection Setup (1 RTT)
    C->>S: SYN (seq=1000, flags=SYN)
    Note over S: allocates receive buffer, picks seq=5000
    S->>C: SYN-ACK (seq=5000, ack=1001, flags=SYN+ACK)
    C->>S: ACK (seq=1001, ack=5001, flags=ACK)
    Note over C,S: ESTABLISHED — data can flow

    Note over C,S: Data Transfer
    C->>S: DATA (seq=1001, 500 bytes of HTTP request)
    S->>C: ACK (ack=1501)
    S->>C: DATA (seq=5001, 1460 bytes of HTTP response)
    C->>S: ACK (ack=6461)
```

Same exchange, one packet at a time:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. SYN.</strong> Client picks an initial sequence number (ISN) &mdash; here <code>seq=1000</code> &mdash; and sends a segment with only the SYN flag set. No payload. This says: "I want to talk, and I'm starting my byte count at 1000."
    </div>
    <div class="stepper-panel">
      <strong>2. SYN-ACK.</strong> Server allocates a receive buffer, picks its own ISN (<code>seq=5000</code>), and replies with two flags at once: SYN (its own request to talk) plus ACK (<code>ack=1001</code>, acknowledging the client's SYN). One packet doing two jobs.
    </div>
    <div class="stepper-panel">
      <strong>3. ACK.</strong> Client acknowledges the server's SYN with <code>ack=5001</code>. Both sides now know each other's starting sequence number. State flips to ESTABLISHED on both ends &mdash; still zero bytes of application data exchanged so far.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

**Sequence numbers** are byte offsets, not packet numbers. `seq=1001` means "this segment starts at byte 1001". `ack=1501` means "I received up to byte 1500, give me byte 1501 next".

<div class="quiz-card">
  <p class="quiz-q">The server's SYN-ACK carries <code>ack=1001</code> when the client's SYN had <code>seq=1000</code>. Why 1001 and not 1000?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Sequence/ack numbers count bytes, not packets, and a bare SYN consumes one sequence number even though it carries no payload. Acknowledging a SYN sent at <code>seq=1000</code> means "next byte I expect is 1001" &mdash; the ack number is always one past the highest byte successfully received, never the byte itself.</div>
</div>

### 4-Way Teardown

```mermaid
sequenceDiagram
    participant C as Client (active close)
    participant S as Server (passive close)

    C->>S: FIN (seq=2000) "I'm done sending"
    S->>C: ACK (ack=2001) "Got your FIN"
    Note over S: server may still send data
    S->>C: DATA (remaining data...)
    S->>C: FIN (seq=7000) "I'm done too"
    C->>S: ACK (ack=7001)
    Note over C: enters TIME_WAIT (60s)
    Note over C,S: Connection closed
```

**Why 4-way?** FIN closes one direction only. Both sides must FIN independently. Half-close is valid — server can receive your FIN and keep sending data.

**TIME_WAIT (60s):** Client stays in TIME_WAIT after sending the last ACK. Prevents old packets from a dead connection being accepted by a new connection on the same port pair.

Same exchange, one packet at a time:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. FIN from the active closer.</strong> Client sends <code>seq=2000</code> with the FIN flag: "I'm done sending." It moves to FIN_WAIT_1. This only closes the client-to-server direction.
    </div>
    <div class="stepper-panel">
      <strong>2. ACK from the passive closer.</strong> Server acknowledges with <code>ack=2001</code>. Client advances to FIN_WAIT_2. The server is not obligated to close yet — it can keep sending data on its own half of the connection.
    </div>
    <div class="stepper-panel">
      <strong>3. FIN from the passive closer.</strong> Once the server has nothing left to send, it sends its own FIN (<code>seq=7000</code>) and moves to LAST_ACK.
    </div>
    <div class="stepper-panel">
      <strong>4. ACK from the active closer.</strong> Client acknowledges with <code>ack=7001</code>. Server sees this and closes immediately. Client instead enters TIME_WAIT for 60s before it fully closes.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Which side ends up in TIME_WAIT after this exchange — the active closer or the passive closer?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The active closer &mdash; whichever side sent the <em>final</em> ACK (the client in this example). TIME_WAIT exists to protect that last ACK: if it gets lost and the peer retransmits its FIN, the active closer needs to still be around to resend the ACK, and the port pair needs to stay reserved so a stray late packet from this connection can't be mistaken for one on a brand-new connection.</div>
</div>

### TCP State Machine

```mermaid
stateDiagram-v2
    [*] --> CLOSED
    CLOSED --> LISTEN: server listen()
    CLOSED --> SYN_SENT: client connect()
    SYN_SENT --> ESTABLISHED: SYN-ACK received + ACK sent
    LISTEN --> SYN_RCVD: SYN received
    SYN_RCVD --> ESTABLISHED: ACK received

    ESTABLISHED --> FIN_WAIT_1: app close() — send FIN
    ESTABLISHED --> CLOSE_WAIT: FIN received from peer
    FIN_WAIT_1 --> FIN_WAIT_2: ACK received
    FIN_WAIT_2 --> TIME_WAIT: peer FIN received
    CLOSE_WAIT --> LAST_ACK: app close() — send FIN
    LAST_ACK --> CLOSED: ACK received
    TIME_WAIT --> CLOSED: 2×MSL timeout (60s)
```

<div class="quiz-card">
  <p class="quiz-q">A socket has been sitting in CLOSE_WAIT for minutes. What does that tell you, and whose bug is it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The peer already sent its FIN &mdash; that's what moved this socket into CLOSE_WAIT in the first place. The only edge leaving CLOSE_WAIT is "app close() &mdash; send FIN," which means the local application simply hasn't called <code>close()</code> on its end yet. A socket parked in CLOSE_WAIT for a long time almost always means a local file-descriptor/socket leak, not a network problem.</div>
</div>

### Flow Control — Receive Window

```mermaid
graph LR
    SND["Sender"] -->|"data up to window size"| RCV["Receiver<br>receive buffer: 65535 bytes"]
    RCV -->|"window advertisement in ACK"| SND
    SND -->|"stop sending when window=0"| SND
```

The receiver advertises how much buffer space it has (window size). Sender never sends more unacknowledged bytes than the window. If the app is slow to read, the buffer fills, window shrinks to 0 → sender stops. **Backpressure all the way to the source.**

<div class="quiz-card">
  <p class="quiz-q">The receiving application stalls (stuck in a long computation, not calling <code>read()</code>). Does the sender find out immediately, and how?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Not immediately, but soon. The receive buffer keeps filling with unread data, so the window size advertised in each ACK shrinks. Once it hits 0, the sender must stop &mdash; it can never have more unacknowledged bytes in flight than the last advertised window. That's backpressure propagating from a slow reader all the way back to the sender, with no application-level signaling involved.</div>
</div>

### Try It Yourself: Live Receive Window

Drive both sides yourself. "Send N bytes" is the sender pushing data into flight; "App reads N bytes" is the receiving application draining its buffer at whatever pace *you* choose, completely independent of the sends. Try starving the reads for a while and watch the window hit 0 and sends start getting rejected &mdash; then read to reopen it.

<div class="structure-viz" id="flowctrl-viz">
  <svg class="viz-canvas" viewBox="0 0 460 170"></svg>
  <div class="viz-controls">
    <input class="viz-input" id="flowctrl-send-n" type="number" min="1" value="16" placeholder="bytes" />
    <button class="viz-btn" data-viz-action="send">Send N bytes</button>
    <input class="viz-input" id="flowctrl-read-n" type="number" min="1" value="16" placeholder="bytes" />
    <button class="viz-btn" data-viz-action="read">App reads N bytes</button>
    <button class="viz-btn viz-btn-danger" data-viz-action="reset">Reset</button>
  </div>
  <div class="viz-status"></div>
  <div class="viz-legend">
    <span><span class="viz-swatch" style="background: color-mix(in srgb, var(--bad) 20%, var(--surface)); border: 1.5px solid var(--bad);"></span>unread bytes in buffer</span>
    <span><span class="viz-swatch" style="background: color-mix(in srgb, var(--ok) 20%, var(--surface)); border: 1.5px solid var(--ok);"></span>advertised window (space left)</span>
  </div>
</div>

<script>
(function () {
  const svgNS = 'http://www.w3.org/2000/svg';
  const root = document.getElementById('flowctrl-viz');
  const svg = root.querySelector('.viz-canvas');
  const status = root.querySelector('.viz-status');
  const sendInput = root.querySelector('#flowctrl-send-n');
  const readInput = root.querySelector('#flowctrl-read-n');

  const CAPACITY = 64;

  // --- Pure state-transition logic (no DOM) ---
  function makeState() { return { unread: 0, capacity: CAPACITY }; }
  function advertisedWindow(state) { return state.capacity - state.unread; }
  function send(state, n) {
    if (!Number.isFinite(n) || n <= 0) return { state, accepted: false, reason: 'invalid' };
    const window = advertisedWindow(state);
    if (n > window) return { state, accepted: false, reason: 'window-exceeded' };
    return { state: { unread: state.unread + n, capacity: state.capacity }, accepted: true, reason: 'ok' };
  }
  function read(state, n) {
    if (!Number.isFinite(n) || n <= 0) return { state, read: 0, reason: 'invalid' };
    const actual = Math.min(n, state.unread);
    return { state: { unread: state.unread - actual, capacity: state.capacity }, read: actual, reason: actual > 0 ? 'ok' : 'empty' };
  }

  let state = makeState();

  // --- Layout geometry (matches viewBox 0 0 460 170) ---
  const BAR_X = 130, BAR_W = 260;
  const UNREAD_BAR_Y = 30, UNREAD_BAR_H = 34;
  const WINDOW_BAR_Y = 96, WINDOW_BAR_H = 34;

  function el(tag, attrs) {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function setStatus(msg, kind) {
    status.textContent = msg;
    status.className = 'viz-status' + (kind === 'ok' ? ' viz-status-ok' : kind === 'error' ? ' viz-status-error' : '');
  }

  function draw() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const window = advertisedWindow(state);
    const unreadFillW = Math.max(0, Math.min(BAR_W, (state.unread / state.capacity) * BAR_W));
    const windowFillW = Math.max(0, Math.min(BAR_W, (window / state.capacity) * BAR_W));

    // Row 1: unread/in-flight bytes
    const l1 = el('text', { x: 10, y: UNREAD_BAR_Y + UNREAD_BAR_H / 2, 'text-anchor': 'start' });
    l1.textContent = 'In-flight / unread:';
    svg.appendChild(l1);
    svg.appendChild(el('rect', { x: BAR_X, y: UNREAD_BAR_Y, width: BAR_W, height: UNREAD_BAR_H, rx: 5, class: 'viz-edge', fill: 'none' }));
    svg.appendChild(el('rect', {
      x: BAR_X, y: UNREAD_BAR_Y, width: unreadFillW, height: UNREAD_BAR_H, rx: 5,
      class: state.unread >= state.capacity ? 'viz-node-removing' : 'viz-node',
    }));
    const t1 = el('text', { x: BAR_X + BAR_W + 12, y: UNREAD_BAR_Y + UNREAD_BAR_H / 2, 'text-anchor': 'start' });
    t1.textContent = state.unread + ' / ' + state.capacity;
    svg.appendChild(t1);

    // Row 2: advertised window
    const l2 = el('text', { x: 10, y: WINDOW_BAR_Y + WINDOW_BAR_H / 2, 'text-anchor': 'start' });
    l2.textContent = 'Advertised window:';
    svg.appendChild(l2);
    svg.appendChild(el('rect', { x: BAR_X, y: WINDOW_BAR_Y, width: BAR_W, height: WINDOW_BAR_H, rx: 5, class: 'viz-edge', fill: 'none' }));
    svg.appendChild(el('rect', {
      x: BAR_X, y: WINDOW_BAR_Y, width: windowFillW, height: WINDOW_BAR_H, rx: 5,
      class: window <= 0 ? 'viz-node-highlight' : 'viz-node-new',
    }));
    const t2 = el('text', { x: BAR_X + BAR_W + 12, y: WINDOW_BAR_Y + WINDOW_BAR_H / 2, 'text-anchor': 'start' });
    t2.textContent = window + ' / ' + state.capacity;
    svg.appendChild(t2);

    // Capacity footer
    const cap = el('text', { x: BAR_X + BAR_W / 2, y: WINDOW_BAR_Y + WINDOW_BAR_H + 22, class: 'viz-label-dim' });
    cap.textContent = 'receive buffer capacity: ' + state.capacity + ' units';
    svg.appendChild(cap);
  }

  root.querySelector('[data-viz-action="send"]').addEventListener('click', () => {
    const n = parseInt(sendInput.value, 10);
    if (!Number.isFinite(n) || n <= 0) {
      setStatus('Enter a positive number of bytes to send.', 'error');
      return;
    }
    const window = advertisedWindow(state);
    const result = send(state, n);
    if (!result.accepted) {
      setStatus(
        `Send of ${n} bytes REJECTED — advertised window is only ${window}. Sender must stall until the app reads more.`,
        'error'
      );
      return;
    }
    state = result.state;
    setStatus(`Sent ${n} bytes. Buffer now ${state.unread}/${state.capacity} unread, window shrank to ${advertisedWindow(state)}.`, 'ok');
    draw();
  });

  root.querySelector('[data-viz-action="read"]').addEventListener('click', () => {
    const n = parseInt(readInput.value, 10);
    if (!Number.isFinite(n) || n <= 0) {
      setStatus('Enter a positive number of bytes to read.', 'error');
      return;
    }
    if (state.unread === 0) {
      setStatus('Nothing to read — buffer is already empty.', '');
      return;
    }
    const result = read(state, n);
    state = result.state;
    setStatus(`App read ${result.read} bytes. Buffer now ${state.unread}/${state.capacity} unread, window reopened to ${advertisedWindow(state)}.`, 'ok');
    draw();
  });

  root.querySelector('[data-viz-action="reset"]').addEventListener('click', () => {
    state = makeState();
    setStatus('Reset — buffer empty, full window advertised.', '');
    draw();
  });

  setStatus('Buffer starts empty (window = ' + CAPACITY + '). Try sending more than the buffer can hold, or starve the reads to watch the window hit 0 and sends get rejected.', '');
  draw();
})();
</script>

### Congestion Control — CUBIC / BBR

Congestion control prevents a sender from overwhelming the network. The sender maintains a **congestion window (cwnd)** — the maximum number of unacknowledged bytes in flight.

```mermaid
graph LR
    START["Start: Slow Start<br>cwnd = 1 MSS<br>Double cwnd each RTT"] -->|"cwnd reaches ssthresh"| CA
    CA["Congestion Avoidance<br>cwnd += 1 MSS per RTT<br>(linear growth)"] -->|"packet loss: 3 dup ACKs"| FR
    FR["Fast Retransmit<br>retransmit lost segment immediately<br>without waiting for timeout"] --> FRR
    FRR["Fast Recovery (CUBIC)<br>ssthresh = cwnd/2<br>cwnd = ssthresh<br>resume Congestion Avoidance"] --> CA
    CA -->|"timeout (severe loss)"| SS2
    SS2["Slow Start again<br>ssthresh = cwnd/2<br>cwnd = 1 MSS"] --> CA
```

Same four phases, flip through them one at a time:

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="slowstart" class="active">Slow Start</button>
    <button data-tab="ca">Congestion Avoidance</button>
    <button data-tab="fr">Fast Retransmit</button>
    <button data-tab="frr">Fast Recovery</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="slowstart">
      <strong>Exponential growth.</strong> Starts at <code>cwnd = 1 MSS</code>. Every ACK received bumps <code>cwnd</code> up by 1 MSS, which doubles the window every RTT. Runs until <code>cwnd</code> reaches <code>ssthresh</code> (initially 64KB) &mdash; or until a timeout resets everything back to this phase.
    </div>
    <div class="tab-panel" data-tab-panel="ca">
      <strong>Linear growth.</strong> Once past <code>ssthresh</code>, each ACK only adds <code>(MSS &times; MSS) / cwnd</code>, which works out to roughly +1 MSS per full RTT instead of per ACK. Cautious probing for more bandwidth instead of the aggressive doubling of Slow Start. Continues until loss is detected.
    </div>
    <div class="tab-panel" data-tab-panel="fr">
      <strong>Triggered by 3 duplicate ACKs.</strong> The receiver keeps ACKing the last good segment because a later one arrived out of order &mdash; a sign of moderate, isolated loss. The sender retransmits the missing segment immediately, without waiting for a full retransmission timeout.
    </div>
    <div class="tab-panel" data-tab-panel="frr">
      <strong>Recover without restarting from scratch.</strong> <code>ssthresh</code> is halved to <code>cwnd/2</code>, and <code>cwnd</code> is set to that same halved value &mdash; not reset to 1 MSS. Congestion Avoidance resumes immediately from there. This is what makes Fast Recovery so much gentler than a timeout.
    </div>
  </div>
</div>

**Live simulator — drive the state machine yourself:**

<div class="structure-viz" id="cwnd-demo">
  <svg class="viz-canvas" viewBox="0 0 300 194"></svg>
  <div class="viz-controls">
    <button class="viz-btn" data-viz-action="ack">ACK</button>
    <button class="viz-btn viz-btn-danger" data-viz-action="dupack3">3 Dup ACKs</button>
    <button class="viz-btn viz-btn-danger" data-viz-action="timeout">Timeout</button>
    <button class="viz-btn" data-viz-action="reset">Reset</button>
  </div>
  <div class="viz-status"></div>
  <div class="viz-legend">
    <span><span class="viz-swatch" style="background: color-mix(in srgb, var(--ok) 20%, var(--surface)); border: 1.5px solid var(--ok);"></span>Slow Start (exponential)</span>
    <span><span class="viz-swatch" style="background: color-mix(in srgb, var(--accent) 16%, var(--surface)); border: 1.5px solid var(--accent);"></span>Congestion Avoidance (linear)</span>
    <span><span class="viz-swatch" style="background: color-mix(in srgb, var(--warn) 20%, var(--surface)); border: 1.5px solid var(--warn);"></span>3 Dup ACKs &rarr; Fast Recovery</span>
    <span><span class="viz-swatch" style="background: color-mix(in srgb, var(--bad) 20%, var(--surface)); border: 1.5px solid var(--bad);"></span>Timeout</span>
  </div>
</div>

<script>
(function () {
  const svgNS = 'http://www.w3.org/2000/svg';
  const root = document.getElementById('cwnd-demo');
  const svg = root.querySelector('.viz-canvas');
  const status = root.querySelector('.viz-status');

  // ---- Layout constants ----
  const WINDOW = 20;
  const BAR_STEP = 44;
  const BAR_GAP = 10;
  const LEFT_MARGIN = 44;
  const RIGHT_MARGIN = 16;
  const TOP_MARGIN = 24;
  const CHART_H = 140;
  const BOTTOM_MARGIN = 30;

  const INITIAL_STATE = { phase: 'slow-start', cwnd: 1, ssthresh: 64 };
  let state = { ...INITIAL_STATE };
  let history = []; // full history; chart renders only the last WINDOW entries

  // ---- Pure state machine: (state, event) -> new state ----
  function transition(s, event) {
    const { cwnd, ssthresh, phase } = s;

    if (event === 'timeout') {
      const newSsthresh = Math.max(1, Math.floor(cwnd / 2));
      return { phase: 'slow-start', cwnd: 1, ssthresh: newSsthresh };
    }

    if (event === 'dupack3') {
      const newSsthresh = Math.max(1, Math.floor(cwnd / 2));
      return { phase: 'fast-recovery', cwnd: newSsthresh + 3, ssthresh: newSsthresh };
    }

    if (event === 'ack') {
      if (phase === 'fast-recovery') {
        // First new ACK after fast recovery deflates cwnd to ssthresh and
        // resumes congestion avoidance.
        return { phase: 'congestion-avoidance', cwnd: ssthresh, ssthresh };
      }
      if (cwnd < ssthresh) {
        // Slow start: exponential growth (doubles cwnd per ACK).
        const grown = cwnd * 2;
        const newPhase = grown >= ssthresh ? 'congestion-avoidance' : 'slow-start';
        return { phase: newPhase, cwnd: grown, ssthresh };
      }
      // Congestion avoidance: linear growth (+1 MSS per ACK).
      return { phase: 'congestion-avoidance', cwnd: cwnd + 1, ssthresh };
    }

    throw new Error('unknown event: ' + event);
  }

  function phaseLabel(phase) {
    if (phase === 'slow-start') return 'Slow Start';
    if (phase === 'congestion-avoidance') return 'Congestion Avoidance';
    if (phase === 'fast-recovery') return 'Fast Recovery';
    return phase;
  }

  // ---- Pure layout: (history, currentSsthresh) -> drawing instructions ----
  // Two independent safeguards against unbounded growth, both required:
  //  1. Only the last WINDOW events are drawn -> canvas WIDTH is bounded.
  //  2. Bar heights are scaled against the current max value in that
  //     window -> canvas HEIGHT never needs to grow no matter how large
  //     cwnd gets.
  function computeLayout(fullHistory, currentSsthresh) {
    const visible = fullHistory.slice(-WINDOW);
    const count = visible.length;
    const width = LEFT_MARGIN + RIGHT_MARGIN + Math.max(count, 1) * BAR_STEP;
    const height = TOP_MARGIN + CHART_H + BOTTOM_MARGIN;
    const maxCwnd = visible.reduce((m, e) => Math.max(m, e.cwnd), 0);
    const maxVal = Math.max(maxCwnd, currentSsthresh, 1) * 1.15;

    const bars = visible.map((entry, i) => {
      const x = LEFT_MARGIN + i * BAR_STEP;
      const w = BAR_STEP - BAR_GAP;
      const h = Math.max(2, (entry.cwnd / maxVal) * CHART_H);
      const y = TOP_MARGIN + (CHART_H - h);
      let color;
      if (entry.event === 'timeout') color = 'viz-node-removing';
      else if (entry.event === 'dupack3') color = 'viz-node-highlight';
      else color = entry.phase === 'slow-start' ? 'viz-node-new' : 'viz-node';
      const tickLabel = entry.event === 'ack' ? 'A' : entry.event === 'dupack3' ? '3D' : 'TO';
      return { x, y, w, h, color, tickLabel, tickX: x + w / 2, tickY: TOP_MARGIN + CHART_H + 16, cwnd: entry.cwnd };
    });

    const ssthreshFrac = Math.min(1, currentSsthresh / maxVal);
    const ssthreshY = TOP_MARGIN + CHART_H - ssthreshFrac * CHART_H;
    const lastBar = bars[bars.length - 1] || null;

    return {
      width,
      height,
      bars,
      ssthreshLine: count > 0 ? { x1: LEFT_MARGIN - 4, x2: width - RIGHT_MARGIN, y: ssthreshY, label: currentSsthresh } : null,
      maxLabel: 'max ' + Math.round(maxVal),
      lastValueLabel: lastBar ? { x: lastBar.x + lastBar.w / 2, y: lastBar.y - 8, text: String(lastBar.cwnd) } : null,
      truncated: fullHistory.length > WINDOW,
      totalEvents: fullHistory.length,
    };
  }

  function el(tag, attrs, text) {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function draw() {
    svg.innerHTML = '';
    const layout = computeLayout(history, state.ssthresh);
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);

    if (history.length === 0) {
      svg.appendChild(el('text', { x: layout.width / 2, y: layout.height / 2, class: 'viz-label-dim' }, 'No events yet — click ACK to begin.'));
      return;
    }

    // ssthresh reference line (drawn first, under the bars).
    if (layout.ssthreshLine) {
      const line = el('line', {
        x1: layout.ssthreshLine.x1, x2: layout.ssthreshLine.x2,
        y1: layout.ssthreshLine.y, y2: layout.ssthreshLine.y,
        class: 'viz-edge-active',
      });
      line.setAttribute('stroke-dasharray', '4 3');
      svg.appendChild(line);
      svg.appendChild(el('text', {
        x: layout.ssthreshLine.x2 - 2, y: layout.ssthreshLine.y - 7, class: 'viz-label-dim',
        style: 'text-anchor: end;',
      }, 'ssthresh=' + layout.ssthreshLine.label));
    }

    // max-value scale reference, top-left corner.
    svg.appendChild(el('text', { x: 4, y: 14, class: 'viz-label-dim', style: 'text-anchor: start;' }, layout.maxLabel));

    // Bars + per-bar event tick.
    for (const bar of layout.bars) {
      svg.appendChild(el('rect', { x: bar.x, y: bar.y, width: bar.w, height: bar.h, rx: 2, class: bar.color }));
      svg.appendChild(el('text', { x: bar.tickX, y: bar.tickY, class: 'viz-label-dim' }, bar.tickLabel));
    }

    // Numeric cwnd label on only the most recent bar (avoids label overlap
    // as more bars appear; the status line always shows the exact number).
    if (layout.lastValueLabel) {
      svg.appendChild(el('text', { x: layout.lastValueLabel.x, y: layout.lastValueLabel.y }, layout.lastValueLabel.text));
    }
  }

  function updateStatus(event) {
    const names = { ack: 'ACK', dupack3: '3 duplicate ACKs', timeout: 'Timeout' };
    const windowNote = history.length > WINDOW ? ` (chart showing last ${WINDOW} of ${history.length} events)` : '';
    status.textContent = `${names[event]} → phase: ${phaseLabel(state.phase)}, cwnd = ${state.cwnd}, ssthresh = ${state.ssthresh}${windowNote}`;
    status.className = event === 'timeout' ? 'viz-status viz-status-error'
      : event === 'dupack3' ? 'viz-status'
      : 'viz-status viz-status-ok';
  }

  function fire(event) {
    state = transition(state, event);
    history.push({ event, cwnd: state.cwnd, ssthresh: state.ssthresh, phase: state.phase });
    updateStatus(event);
    draw();
  }

  root.querySelector('[data-viz-action="ack"]').addEventListener('click', () => fire('ack'));
  root.querySelector('[data-viz-action="dupack3"]').addEventListener('click', () => fire('dupack3'));
  root.querySelector('[data-viz-action="timeout"]').addEventListener('click', () => fire('timeout'));
  root.querySelector('[data-viz-action="reset"]').addEventListener('click', () => {
    state = { ...INITIAL_STATE };
    history = [];
    status.textContent = 'Reset. Phase: Slow Start, cwnd = 1, ssthresh = 64.';
    status.className = 'viz-status';
    draw();
  });

  status.textContent = 'Phase: Slow Start, cwnd = 1, ssthresh = 64. Click ACK, 3 Dup ACKs, or Timeout to drive the state machine.';
  draw();
})();
</script>

**Phase 1 — Slow Start:**
```
cwnd starts at 1 MSS (Maximum Segment Size, ~1460 bytes)
Each ACK received → cwnd += 1 MSS
Effect: cwnd doubles every RTT (exponential)
Stops when cwnd >= ssthresh (slow start threshold, initially 64KB)
```

**Phase 2 — Congestion Avoidance:**
```
Each ACK → cwnd += (MSS × MSS) / cwnd
Effect: cwnd increases by 1 MSS per full RTT (linear)
Continues until packet loss detected
```

**Loss detection:**
- **Timeout:** No ACK for 1 RTO (Retransmission Timeout). Severe — resets cwnd to 1 MSS.
- **3 Duplicate ACKs:** Receiver keeps ACKing last good segment. Moderate loss — Fast Retransmit without full slow start.

**Concrete example (CUBIC):**
```
RTT 0: cwnd=1 (1 MSS = 1460 bytes in flight)
RTT 1: cwnd=2
RTT 2: cwnd=4
RTT 3: cwnd=8  (slow start, ssthresh not hit yet)
RTT 4: cwnd=16
RTT 5: cwnd=32
RTT 6: cwnd=64 = ssthresh → switch to congestion avoidance
RTT 7: cwnd=65
RTT 8: cwnd=66  (linear now)
...
RTT N: packet loss detected (3 dup ACKs)
     ssthresh = cwnd/2 = 33
     cwnd = 33 (fast recovery, not back to 1)
RTT N+1: cwnd=34 (resume linear growth from ssthresh)
```

<div class="quiz-card">
  <p class="quiz-q">3 duplicate ACKs just triggered Fast Retransmit. Does <code>cwnd</code> collapse all the way back to 1 MSS, the way a full timeout would?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. A timeout means severe, unconfirmed loss, so it resets <code>cwnd</code> to 1 MSS and restarts Slow Start from zero. 3 duplicate ACKs mean the network is still delivering packets &mdash; just one segment went missing &mdash; so Fast Recovery only halves <code>ssthresh</code> and <code>cwnd</code> (e.g. 64 &rarr; 33 in the example above) and resumes Congestion Avoidance from there. Same underlying signal (loss), very different severity, very different response.</div>
</div>

### CUBIC vs BBR

```mermaid
graph TD
    subgraph CUBIC["CUBIC (default Linux since 2.6.19)"]
        C1["Loss-based: reacts AFTER packet is dropped"]
        C2["On loss: cwnd = cwnd/2"]
        C3["Recovery: cubic curve to previous cwnd"]
        C4["Problem: causes packet loss to probe bandwidth<br>wastes bandwidth intentionally"]
    end

    subgraph BBR["BBR — Bottleneck Bandwidth and RTT (Google, 2016)"]
        B1["Model-based: estimates bottleneck bandwidth + RTprop"]
        B2["Probes bandwidth WITHOUT causing loss"]
        B3["Sends at BDP = bandwidth × RTprop"]
        B4["Better for long-fat networks (satellite, cross-ocean)"]
        B5["No loss = no buffer bloat"]
    end
```

| | CUBIC | BBR |
|--|-------|-----|
| Trigger | Packet loss | Bandwidth model |
| On loss | cwnd halved | No direct response to loss |
| Buffer bloat | Yes (fills buffers) | No |
| Cross-ocean links | Underperforms | Excellent |
| LAN / datacenter | Good | Can be aggressive |
| Default Linux | Yes (since 2.6.19) | Opt-in |

<div class="quiz-card">
  <p class="quiz-q">Does BBR need to actually see a packet get dropped before it backs off, the way CUBIC does?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. CUBIC is loss-based &mdash; it deliberately keeps growing <code>cwnd</code> until something drops, then halves it, so causing occasional loss is baked into how it finds available bandwidth. BBR is model-based: it estimates bottleneck bandwidth and round-trip propagation time directly and paces sending at that rate (BDP), so it can find the right sending rate without ever needing to overflow a buffer first.</div>
</div>

```bash
# Check current algorithm
sysctl net.ipv4.tcp_congestion_control
# tcp_congestion_control = cubic

# Enable BBR
modprobe tcp_bbr
sysctl -w net.ipv4.tcp_congestion_control=bbr
sysctl -w net.core.default_qdisc=fq   # required for BBR

# Persist
echo "net.core.default_qdisc=fq" >> /etc/sysctl.conf
echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf

# Verify BBR is active
ss -i | grep bbr
```

### CWND and BDP (Bandwidth-Delay Product)

```
BDP = bandwidth × RTT

Example: 1 Gbps link, 100ms RTT
BDP = 1,000,000,000 bits/s × 0.1s = 100,000,000 bits = 12.5 MB

The sender must have up to 12.5 MB of unacknowledged data in flight
to fully utilize a 1 Gbps link with 100ms RTT.

If cwnd < BDP → sender is artificially limited → underutilizing the link.
This is why TCP buffer sizes matter:
sysctl -w net.ipv4.tcp_rmem="4096 87380 134217728"  # 128MB max
```

<div class="quiz-card">
  <p class="quiz-q">A server on a 1 Gbps link with 100ms RTT has its TCP buffers capped so <code>cwnd</code> can never exceed 2MB. Can it saturate the link?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. BDP for this link is 1,000,000,000 bits/s &times; 0.1s = 12.5 MB &mdash; that's how much data needs to be in flight, unacknowledged, to keep the pipe full. Capping <code>cwnd</code> at 2MB means the sender is artificially limited to roughly 2/12.5 of the link's capacity, no matter how fast the network actually is. This is exactly why <code>tcp_rmem</code>/<code>tcp_wmem</code> tuning matters more on high-bandwidth, high-RTT ("long fat") links than on a LAN.</div>
</div>

### Key TCP Tuning

```bash
# Accept queue — how many completed handshakes kernel queues before app calls accept()
sysctl -w net.core.somaxconn=65535

# SYN queue — incomplete handshakes
sysctl -w net.ipv4.tcp_max_syn_backlog=65535

# TIME_WAIT reuse — allow outbound connections to reuse TIME_WAIT sockets
sysctl -w net.ipv4.tcp_tw_reuse=1

# Keepalive — detect dead connections (default 7200s = terrible)
sysctl -w net.ipv4.tcp_keepalive_time=60
sysctl -w net.ipv4.tcp_keepalive_intvl=10
sysctl -w net.ipv4.tcp_keepalive_probes=5

# Ephemeral port range (for many outbound connections)
sysctl -w net.ipv4.ip_local_port_range="1024 65535"
```

---

## UDP — User Datagram Protocol

UDP is **connectionless, unreliable, unordered**. No handshake, no ACK, no retransmit. Just send a datagram and hope.

```mermaid
graph LR
    C["Client"] -->|"datagram: no SYN, no ACK, no seq numbers"| S["Server"]
    S -->|"response datagram (or nothing)"| C
    Note1["Lost packet? Gone forever."]
    Note2["Out-of-order? App must handle."]
    Note3["Duplicate? App must handle."]
```

**UDP header:** only 8 bytes (vs TCP's 20 bytes minimum):
```
Source Port (2B) | Dest Port (2B) | Length (2B) | Checksum (2B) | Data
```

<div class="quiz-card">
  <p class="quiz-q">A UDP datagram arrives at the receiver twice (network-level duplication). Who notices and drops the extra copy?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Nobody, at the transport layer. UDP has no sequence numbers and keeps no per-connection state, so it has nothing to compare the duplicate against. If duplicates matter, the application has to detect and drop them itself &mdash; the same way it's on the hook for lost and out-of-order datagrams.</div>
</div>

### TCP vs UDP

| Feature | TCP | UDP |
|---------|-----|-----|
| Connection | 3-way handshake | None |
| Reliability | ACK + retransmit | No guarantee |
| Ordering | Sequence numbers | No |
| Overhead | 20+ byte header + handshake RTT | 8 byte header, no setup |
| Congestion control | Yes (CUBIC/BBR) | No (app responsibility) |
| Flow control | Receive window | No |
| Latency | Higher (ACK, retransmit delays) | Lower |
| Use case | HTTP, SSH, DB connections | DNS, QUIC, video, gaming |

Same comparison, one protocol at a time:

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="tcp" class="active">TCP</button>
    <button data-toggle-opt="udp">UDP</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="tcp">
    Pays a full RTT up front (3-way handshake) before a single byte moves. In exchange it guarantees every byte arrives exactly once, in order, and backs off automatically when the network is congested (CUBIC/BBR) or the receiver is slow (receive window). That safety net is also where its latency and per-connection overhead come from.
  </div>
  <div class="toggle-panel" data-toggle-panel="udp">
    No handshake, no connection state, an 8-byte header. Send a datagram and it either arrives or it doesn't &mdash; no retransmit, no reordering, no dedup. Lower latency and less overhead by construction, but reliability, ordering, and congestion behavior become the application's problem the moment it needs any of them.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">Which column in the table above has no built-in congestion control, and who ends up responsible for it instead?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>UDP. TCP backs off automatically via CUBIC/BBR when it detects congestion; UDP has no such mechanism at all &mdash; it will keep blasting datagrams at whatever rate the application asks for. Any congestion response has to be built by the application itself, which is exactly what QUIC does by implementing its own congestion control on top of UDP.</div>
</div>

### When to Use UDP

```mermaid
graph TD
    Q1{"Is losing a packet<br>acceptable?"} -->|Yes| UDP["UDP"]
    Q1 -->|No| TCP["TCP"]
    Q2{"Is ordering critical?"} -->|No, app handles it| UDP
    Q2 -->|Yes| TCP
    Q3{"Is latency more<br>important than reliability?"} -->|Yes| UDP
    Q3 -->|No| TCP
```

**DNS (UDP port 53):** Single query/response fits in one datagram. No need for a connection — fast, stateless. Falls back to TCP for responses > 512 bytes (EDNS0 increases this to 4096 bytes).

**QUIC / HTTP/3 (UDP):** Implements its own reliable delivery, multiplexing, and TLS on top of UDP. Avoids TCP's head-of-line blocking — one lost packet doesn't stall other streams.

**Video streaming (UDP):** A dropped frame is better than a frozen stream waiting for retransmit. Application uses FEC (Forward Error Correction) instead.

**Gaming:** Position updates are sent many times per second. A stale position is less harmful than waiting for retransmit of an old position.

<div class="quiz-card">
  <p class="quiz-q">DNS runs over UDP by default. What happens when a response would be bigger than a single datagram can carry?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>It falls back to TCP. Plain UDP DNS responses are capped around 512 bytes; EDNS0 raises that ceiling to 4096 bytes over UDP, but past that the resolver switches to a TCP query instead. DNS isn't "UDP only" &mdash; it's UDP for the common case, with TCP as the fallback for anything too big to fit.</div>
</div>

### Checking Sockets

```bash
# List all UDP sockets
ss -u -a

# List all TCP sockets with process info
ss -t -p

# Show socket state counts
ss -s
# Estab, Time-Wait, Closed, Listen...

# netstat equivalent (older)
netstat -tlnp   # TCP listening with PID
netstat -an | grep TIME_WAIT | wc -l
```
