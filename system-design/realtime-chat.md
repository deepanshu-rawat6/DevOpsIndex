# Real-Time Chat & Messaging Systems

Why request/response breaks down for chat, the transport options that fix it, and everything that gets hard once you scale past one server: connection registries and cross-server relay, delivery guarantees, ordering, presence, multi-device fan-out, group chat at scale, message history, receipts, and offline push. Builds on [async-patterns.md](./async-patterns.md) (pub/sub fan-out, idempotency) and [api-design.md](./api-design.md) (cursor pagination, idempotency keys) rather than re-deriving them.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. Why HTTP Request/Response Doesn't Work

HTTP is fundamentally a pull model: the client sends a request, the server sends exactly one response, and the connection's job is done. The server has no channel to say "here's a new message" unless the client asks first — it can't originate a send.

Chat needs the opposite. A message written by User A has to reach User B's screen the instant it's sent, with User B's client never having asked about it. The only way to fake that on top of plain request/response is **polling**: the client re-asks "anything new?" over and over.

```mermaid
sequenceDiagram
    participant Client
    participant Server

    loop every 3 seconds
        Client->>Server: GET /messages/since?ts=...
        Server-->>Client: 200 OK, no new messages
    end
    Note over Client,Server: A real message arrives here, mid-interval
    Client->>Server: GET /messages/since?ts=...
    Server-->>Client: 200 OK, 1 new message
    Note over Client,Server: Delivered late, up to one full poll interval after it was sent
```

Shorten the interval and latency improves, but almost every request comes back empty — wasted round trips, wasted server CPU answering "nothing new," and a battery/bandwidth cost on mobile that scales with how many chats are open. Lengthen the interval and messages arrive late. There's no interval that's both cheap and instant, because the fix has to be structural: give the server a way to push, not just respond.

That's what every transport in the next section provides — a way for the server to send data to the client without the client asking again first.

<div class="quiz-card">
  <p class="quiz-q">Polling every 500ms instead of every 5s makes chat feel more real-time. Does it solve the underlying problem?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No — it just trades one cost for another. Shortening the interval reduces worst-case latency, but the server still answers mostly-empty requests at a much higher rate, burning more connections, CPU, and (on mobile) battery and data for the same information. The actual problem — the server has no way to push without being asked — is unchanged; polling faster just asks more often.</div>
</div>

---

## 2. Transport Options

Three real ways to get server-initiated delivery to a browser or app, each with a different shape.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="ws" class="active">WebSocket</button>
    <button data-tab="lp">Long-Polling</button>
    <button data-tab="sse">Server-Sent Events</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="ws">
      <strong>One persistent, full-duplex TCP connection.</strong> After an HTTP Upgrade handshake, the connection stops being HTTP — both sides can send frames whenever they want, in either direction, over the same socket.
      <pre><code class="language-mermaid">sequenceDiagram
    participant C as Client
    participant S as Server

    C->>S: GET /chat, header, Upgrade: websocket
    S-->>C: 101 Switching Protocols
    Note over C,S: connection is now a raw full-duplex socket, no more request/response framing
    C->>S: send message frame
    S-->>C: push message frame, unprompted
    S-->>C: push another message frame, unprompted
    C->>S: send typing indicator frame</code></pre>
      <strong>Cost:</strong> one connection held open per client, for as long as the chat is open — that connection is stateful and pinned to whichever server accepted it (see Section 3). <strong>Compatibility:</strong> some corporate proxies and older load balancers don't handle the Upgrade handshake cleanly, though this is rare in 2026. <strong>Bidirectional:</strong> yes, natively — the only transport of the three where the client can push without opening a new request.
    </div>
    <div class="tab-panel" data-tab-panel="lp">
      <strong>Plain HTTP, held open.</strong> The client sends a request; the server doesn't answer until it has something to say (or a timeout hits); the instant the client gets a response, it immediately sends the next request. From the outside it looks like polling, but each request blocks instead of returning empty.
      <pre><code class="language-mermaid">sequenceDiagram
    participant C as Client
    participant S as Server

    C->>S: GET /chat/poll
    Note over S: server holds the request open, no response yet
    Note over S: a message arrives
    S-->>C: 200 OK, message payload
    C->>S: GET /chat/poll, sent immediately on receiving the response above
    Note over S: server holds this one open too, nothing to send yet</code></pre>
      <strong>Cost:</strong> a fresh HTTP request (new TLS-terminated connection or at least new headers) for every single message, plus the request that's always open waiting. <strong>Compatibility:</strong> plain HTTP — works through literally every proxy and firewall that allows normal web traffic, no special handling needed. <strong>Bidirectional:</strong> only in the sense that the client can also POST on a separate connection — the held-open GET is one-way (server to client) in spirit even though it's an HTTP round trip.
    </div>
    <div class="tab-panel" data-tab-panel="sse">
      <strong>One-way server-to-client stream over plain HTTP.</strong> The client opens a normal GET request with <code>Accept: text/event-stream</code> and the server keeps the response open forever, writing new events onto it as they happen — no re-request needed between messages.
      <pre><code class="language-mermaid">sequenceDiagram
    participant C as Client
    participant S as Server

    C->>S: GET /chat/stream, header, Accept: text-event-stream
    S-->>C: 200 OK, Content-Type: text-event-stream, connection stays open
    S-->>C: event, data, message 1
    S-->>C: event, data, message 2
    Note over C,S: same open response, no new request between events
    C->>S: POST /chat/send, on a completely separate connection</code></pre>
      <strong>Cost:</strong> one long-lived HTTP connection, same order of resource cost as a WebSocket. <strong>Compatibility:</strong> plain HTTP under the hood, so it survives most proxies and gets automatic reconnect-with-<code>Last-Event-ID</code> built into the browser <code>EventSource</code> API for free. <strong>Bidirectional:</strong> no — the client must send its own messages over a separate, ordinary HTTP request. That's fine for feeds and live updates, but a chat client still needs a second channel just to send.
    </div>
  </div>
</div>

| Transport | Connections needed | Proxy/firewall friendliness | Bidirectional | Typical fit |
|---|---|---|---|---|
| WebSocket | 1, held open | Good, but Upgrade can trip old middleboxes | Yes, natively | Chat, multiplayer, anything needing low-latency client→server too |
| Long-polling | New request per message + 1 always open | Excellent — plain HTTP | Client sends separately | Fallback when WebSocket is blocked |
| SSE | 1, held open | Excellent — plain HTTP | No — client sends separately | Live feeds, notifications, one-way dashboards |

**Why chat almost always picks WebSocket:** chat is inherently bidirectional at low latency — the client is both sending (its own messages, typing indicators, read receipts) and receiving, and it's doing both constantly. SSE covers the receive half well but forces a second channel for the send half. Long-polling works everywhere but pays a full HTTP request per message, which adds up fast in an active conversation. Most production chat systems still keep long-polling as an automatic fallback for the minority of networks that block WebSocket upgrades.

<div class="quiz-card">
  <p class="quiz-q">A dashboard needs to show live stock prices ticking in, with no user input going the other way. Is WebSocket the right choice here?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>It would work, but it's more than the problem needs. Server-Sent Events fit better: the traffic is purely server-to-client, SSE runs over plain HTTP (friendlier to proxies), and the browser's EventSource API gives automatic reconnect with Last-Event-ID for free. WebSocket earns its cost specifically when the client also needs to push data back at low latency — which a price ticker with no user input doesn't need.</div>
</div>

---

## 3. Connection Management at Scale

A WebSocket connection is stateful: it's an open TCP socket held in the memory of one specific server process. That's fine for a single server, but real chat backends run a fleet of WebSocket gateway servers behind a load balancer, and the load balancer doesn't know or care about chat semantics — it just spreads connections around.

That creates the classic cross-server problem: **User A is connected to Gateway 1. User B is connected to Gateway 2. User A sends a message to User B. How does Gateway 1 — which has never seen User B's socket — get that message to Gateway 2, which is the only process holding the actual TCP connection to User B?**

Two pieces solve it together:

- **Connection registry** — a shared, fast lookup (typically Redis) mapping `user_id → { server_id, connection_id }` for every currently-connected device. Every gateway writes to it on connect/disconnect and reads from it to find where a recipient actually lives.
- **Pub/sub relay** — a message bus (Redis Pub/Sub or a Kafka topic) with one channel per gateway server. Any gateway can publish onto any other gateway's channel; only that one gateway is subscribed to it, so only it receives and pushes the message down the one local socket it actually holds.

```mermaid
graph TD
    classDef client fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:6
    classDef gw fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef registry fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef bus fill:#e67e22,stroke:#ba6018,color:#fff,rx:6

    A["User A — client"]:::client -->|"WebSocket"| GW1["Gateway 1"]:::gw
    B["User B — client"]:::client -->|"WebSocket"| GW2["Gateway 2"]:::gw

    subgraph LOOKUP["Connection registry — shared state, not held by any one gateway"]
        REG["Redis: user_id to server_id, connection_id<br/>written on connect, deleted on disconnect"]:::registry
    end

    subgraph RELAY["Pub/sub relay — one channel per gateway, only that gateway subscribes"]
        BUS["Redis Pub/Sub or Kafka<br/>channel: gateway.2.deliver"]:::bus
    end

    GW1 -->|"1. lookup(user_b)"| REG
    REG -->|"2. server_id = gateway-2"| GW1
    GW1 -->|"3. publish to gateway.2.deliver"| BUS
    BUS -->|"4. only Gateway 2 is subscribed here"| GW2
    GW2 -->|"5. push down the local socket it actually holds"| B
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. User A's message lands on Gateway 1.</strong> Gateway 1 has no idea where User B is connected — it only knows its own local sockets.
    </div>
    <div class="stepper-panel">
      <strong>2. Gateway 1 looks up User B in the connection registry.</strong> A fast key-value read, typically Redis: <code>GET conn:user_b</code> returns something like <code>{server_id: "gateway-2", connection_id: "ws-8841"}</code>.
    </div>
    <div class="stepper-panel">
      <strong>3. Gateway 1 publishes the message onto Gateway 2's channel.</strong> Not a broadcast — a targeted publish onto a channel scoped to exactly one gateway (<code>gateway.2.deliver</code>), so only that one process ever sees it.
    </div>
    <div class="stepper-panel">
      <strong>4. Gateway 2 receives it from its subscription.</strong> Every gateway subscribes only to its own channel, so this delivery never touches Gateway 3, 4, or any other server in the fleet.
    </div>
    <div class="stepper-panel">
      <strong>5. Gateway 2 pushes it down User B's actual socket.</strong> This is the one step no other server in the fleet could have done — only the process holding the live TCP connection can write to it.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

**Why it matters:** without this, horizontally scaling the WebSocket layer would only let you scale the *number of connections you can accept*, not the *number of users who can actually message each other* — any two users landing on different gateways would simply be unreachable from one another. The registry plus relay is what makes "any server can reach any connected client" true despite each connection being pinned to exactly one process.

On disconnect, the gateway must delete its registry entry (or let a short TTL expire it) — a stale entry pointing at a dead connection means messages get published to a channel nobody live is reading, and silently vanish.

<div class="quiz-card">
  <p class="quiz-q">Gateway 1 crashes without cleanly closing its sockets. The registry still lists 500 users as connected to gateway-1. What happens to messages sent to them in the meantime?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>They get published onto gateway-1's channel and go nowhere — gateway-1 is dead, nothing is subscribed to receive them, and the sending gateway has no way to know that from the registry entry alone. This is exactly why the registry entry needs a short TTL refreshed by a heartbeat (the same mechanism Section 6 uses for presence) rather than relying purely on a clean disconnect handler to remove it — a crash never gets the chance to run that handler.</div>
</div>

---

## 4. Message Delivery Guarantees

Once a message is relayed across the fleet, what actually gets promised about it arriving? The same three tiers from [async-patterns.md's delivery guarantees](./async-patterns.md) apply, with chat-specific consequences:

| Guarantee | Behavior | Chat consequence |
|---|---|---|
| At-most-once | Fire and forget, no retry | A dropped connection mid-send silently loses the message — the sender sees no error, the recipient never sees the text |
| At-least-once | Ack required, retry on timeout/no-ack | The same message can arrive twice if the ack itself was lost, even though the message got through fine the first time |
| Effectively-exactly-once | At-least-once delivery + dedup on the receiving side | No silent loss, and duplicates are filtered out before they ever render |

Chat systems build the third tier the same way [async-patterns.md's idempotency section](./async-patterns.md) does for message queues in general — a **client-generated message ID** created before the message is even sent (usually a UUID), attached to the payload, and checked against a dedup store on arrival. The client generates it (not the server) specifically so retries after a dropped connection or timed-out ack reuse the *same* ID instead of minting a new one — the exact same principle as reusing an `Idempotency-Key` across retries in [api-design.md](./api-design.md).

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant D as Dedup store, keyed by client_message_id

    C->>S: send, client_message_id=uuid-A, text
    Note over S,C: ack lost on the way back, client sees a timeout
    C->>S: retry, same client_message_id=uuid-A, same text
    S->>D: check uuid-A
    D-->>S: already processed
    S-->>C: ack, message was already delivered
    Note over C: client stops retrying, exactly one copy of the message exists downstream
```

Without the dedup step this is at-least-once with visible duplicates: the recipient would see the same message text appear twice, because both the original send and the retry got processed as distinct messages.

<div class="quiz-card">
  <p class="quiz-q">Why does the client generate the message ID up front, instead of letting the server assign one when the message is first received?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>If the server assigned the ID, a retry after a lost ack would look like a brand-new message to the server — there'd be nothing to compare it against, since the ID that would've let the server recognize "I've already seen this one" wouldn't exist until the server itself created it fresh, for both the original and the retry. The client has to mint the ID before the first send specifically so the retry can carry the same value, which is the only thing the dedup check has to key on.</div>
</div>

---

## 5. Message Ordering

Chat doesn't need a single global order across every conversation on the platform — nobody cares whether a message in conversation X happened before or after an unrelated message in conversation Y. What matters is that messages **within one conversation** appear in the order they were sent, to everyone reading that conversation.

That's a much easier problem: each conversation gets its own monotonically increasing **sequence number**, assigned when the message is persisted (Section 9). A client tracks the highest sequence number it has seen per conversation; if a message arrives with a sequence number that isn't `last_seen + 1`, there's a gap, and the client knows exactly what range it's missing.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    S-->>C: message, conversation=42, seq=17
    Note over C: last_seen[42] = 17
    S-->>C: message, conversation=42, seq=18
    Note over C: last_seen[42] = 18
    Note over C: next delivery arrives as seq=21, not 19
    C->>C: gap detected, expected 19, got 21
    C->>S: GET, conversation=42, range=19..20
    S-->>C: messages 19 and 20, backfilled from the persisted log
    Note over C: last_seen[42] = 21, gap closed in order
```

This is why per-conversation sequence numbers, not timestamps, are the right ordering key: clocks skew across servers and can even go backwards, but a counter that only ever increments per conversation gives every client an unambiguous way to detect exactly what it's missing and ask for exactly that range — no coordination with any other conversation required.

<div class="quiz-card">
  <p class="quiz-q">Why use a per-conversation sequence number instead of just ordering messages by server-received timestamp?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Timestamps from different servers can skew, and even a single server's clock can jump backwards (NTP correction). A sequence number that only ever increments within one conversation gives every client a reliable, gap-detectable ordering signal regardless of clock behavior — "did I get 19 and 20 before 21" is a simple integer comparison, not a fuzzy time comparison that has to account for clock drift.</div>
</div>

---

## 6. Presence System

Presence — online, offline, typing — is a **heartbeat + TTL** problem, not something a client explicitly announces once and forgets. The client (or its open WebSocket connection) periodically refreshes a Redis key with a short expiry; as long as refreshes keep arriving, the key stays alive and the user reads as online. Stop refreshing — client closes, network dies, app is backgrounded — and the key simply expires on its own. Nobody has to explicitly mark the user offline.

```mermaid
graph TD
    classDef online fill:#27ae60,stroke:#1e8449,color:#fff,rx:6
    classDef ttl fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef offline fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:6

    HB["Client sends heartbeat<br/>every 15s over the open WebSocket"]:::online --> SET["Redis: SET presence:user_42 online EX 30"]:::ttl
    SET -->|"heartbeat arrives again within 30s"| SET
    SET -.->|"30s pass with no refresh"| EXP["Key expires automatically"]:::offline
    EXP --> READ["Any server reading presence:user_42<br/>gets a miss, treats the user as offline"]:::offline
```

**Why presence is inherently eventually consistent:** a heartbeat interval shorter than the TTL (15s heartbeat, 30s TTL above) means there's always a window where a user who just went offline still reads as online, and a brief network blip that delays one heartbeat by a few seconds doesn't flip their status at all — the TTL hasn't lapsed yet. That slack is deliberate: a presence system tuned to flip instantly on any missed beat would flap a user's status on every minor network hiccup, which is worse UX than being a few seconds stale. Presence answers "were they recently active," not "are they connected at this exact millisecond" — and that's a feature, not a bug.

Typing indicators ride the same mechanism at a shorter TTL (2–3 seconds): the client sends a "typing" event on every keystroke (throttled), the server sets a short-lived key, and the indicator disappears automatically the moment the key expires — no explicit "stopped typing" event required either.

<div class="quiz-card">
  <p class="quiz-q">A user's phone loses signal for 5 seconds — well under the 30s presence TTL — and reconnects on its own. Does their contact see them flip to offline and back?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No — that's exactly the slack the TTL is designed to absorb. As long as a heartbeat lands before the 30s key expires, the key never lapses and the status never flips. Only a gap longer than the TTL (client actually closed, or a network outage that outlasts it) causes the key to expire and the user to read as offline. Presence trades a few seconds of staleness for not flapping on every brief blip.</div>
</div>

---

## 7. Multi-Device Fan-Out

Modern chat users are rarely on one device — phone, laptop, tablet, web tab can all be logged into the same account simultaneously. A message addressed to that user has to reach **every active session**, not just whichever one happens to answer first.

This is the same fan-out shape covered in [async-patterns.md's pub/sub pattern](./async-patterns.md) — one message, delivered independently to every subscriber — just applied to a **per-user device list** instead of a social-graph follower list. The connection registry from Section 3 extends naturally: instead of `user_id → one connection`, it holds `user_id → [connection_1, connection_2, connection_3, ...]`, one entry per active session, each potentially on a different gateway.

```mermaid
graph TD
    classDef gw fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef registry fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef device fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    SENDER["Sender's message"] --> REG

    subgraph LOOKUP["Registry now returns a list, not a single connection"]
        REG["user_id: bob to<br/>[phone at gateway-1, laptop at gateway-2, web at gateway-2]"]:::registry
    end

    REG --> GW1["Gateway 1"]:::gw
    REG --> GW2["Gateway 2"]:::gw

    GW1 --> PHONE["Bob's phone"]:::device
    GW2 --> LAPTOP["Bob's laptop"]:::device
    GW2 --> WEB["Bob's web tab"]:::device
```

Two sessions on the *same* gateway (laptop and web tab on Gateway 2 above) still get two independent pushes — the fan-out is per connection, not per server. And per-device delivery state matters here too: if the phone is asleep and misses the WebSocket push, that's an offline-delivery case for that one device (Section 11) even while the laptop and web tab receive it live — multi-device fan-out and per-device delivery state are two different axes of the same message.

<div class="quiz-card">
  <p class="quiz-q">Bob has a laptop and a web tab both connected through the same gateway server. Does that gateway push the message to that connection once, since it's "the same server," or twice?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Twice. Fan-out is per connection, not per server — the laptop and the web tab are two separate WebSocket connections with two separate registry entries, even though they happen to be pinned to the same gateway process. The gateway being shared is an implementation detail of where the sockets live, not a reason to collapse two independent sessions into one delivery.</div>
</div>

---

## 8. Group Chat Fan-Out at Different Scales

A 1:1 message has exactly one recipient to fan out to (times however many devices they have). Group chat has to fan out to every member — and "every member" ranges from 3 people to a 500,000-subscriber broadcast channel, which are different engineering problems wearing the same UI.

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="small" class="active state-ok">Small Group (fan-out-on-write)</button>
    <button data-toggle-opt="broadcast" class="state-warn">Broadcast Channel (fan-out-on-read)</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="small">
    <strong>Fan-out-on-write, a.k.a. push model.</strong> When a message is sent, the server immediately looks up every member's connection(s) via the registry and delivers to each one — the same mechanism as Section 3/7, just looped over a member list instead of a single recipient. For a group of 5–200 people this is cheap: one write, a handful of registry lookups, a handful of pushes, all done in milliseconds. Each member's client also gets to maintain its own simple "last read message" pointer, since the full message stream is small enough to just push at everyone.
    <br/><br/>
    <strong>Breaks down at:</strong> a "group" with 500,000 members turns one message send into 500,000 registry lookups and pushes — most of them to devices that are asleep, backgrounded, or simply not looking at the screen that instant. The write-side work scales with member count, and at broadcast scale that's the bottleneck, not the message volume itself.
  </div>
  <div class="toggle-panel" data-toggle-panel="broadcast">
    <strong>Fan-out-on-read, a.k.a. pull model, applied to chat as a hybrid.</strong> The message is written to the conversation's log exactly once — no per-member copy, no per-member push on send. Each subscriber independently tracks their own **last-read pointer** (a sequence number, per Section 5) and pulls everything newer than that pointer when they actually open the channel or reconnect. Write cost is now O(1) regardless of subscriber count.
    <br/><br/>
    <strong>The tradeoff:</strong> there's no instant push to every subscriber the moment the message lands — a subscriber only "gets" a channel message when they check in, which is fine for a broadcast channel (nobody expects millisecond delivery from a 500K-subscriber announcement channel) but wrong for an active back-and-forth conversation, where instant delivery is the entire point.
  </div>
</div>

**Where the crossover point actually is:** this mirrors the celebrity-problem fan-out tradeoff in [scaling.md's fan-out-on-write vs fan-out-on-read section](./scaling.md) — small fan-out sets favor push because the write cost is trivial and users expect instant delivery; huge fan-out sets favor pull because push cost scales linearly with subscribers while pull cost doesn't scale with subscribers at all. Production chat systems (Slack, Discord, Telegram) draw the line by member count and by expected interactivity: a 50-person team channel still gets fan-out-on-write because people are actively watching it, while a 100K-member broadcast channel switches to fan-out-on-read — write once, let each reader's client catch up against its own last-read pointer.

<div class="quiz-card">
  <p class="quiz-q">A broadcast channel with 200,000 subscribers uses fan-out-on-read. Does sending one message to it cost more, less, or about the same as sending one message in a 5-person group that uses fan-out-on-write?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Less, at write time — the broadcast channel's write is O(1): one append to the conversation log, no per-subscriber lookups or pushes at all. The 5-person group's write does 5 registry lookups and 5 pushes, which is still cheap in absolute terms but scales with member count, unlike the broadcast channel's write. The cost of reaching 200,000 people didn't vanish — it moved to read time, spread across each subscriber's own pull when they check the channel, instead of being paid all at once on write.</div>
</div>

---

## 9. Message Storage & History

A conversation's history is fundamentally an **append-only log**, keyed by conversation, ordered by the sequence number from Section 5. Once a message is written, it's essentially never updated in place (edits and deletes are usually modeled as new events referencing the original, not in-place mutation) — which is exactly the append-only, time-ordered access pattern of a time-series or log store, not the update-heavy access pattern a relational schema is built for.

That shapes the storage choice: a wide-column or log-oriented store (Cassandra, DynamoDB, or a well-partitioned append-only table) with `conversation_id` as the partition key and `sequence_number` as the sort/clustering key reads and writes exactly the way chat actually behaves — recent messages in one conversation, read in order, almost never touched again after being written.

```mermaid
graph LR
    classDef part fill:#2c3e50,stroke:#1a252f,color:#fff,rx:6
    classDef msg fill:#3498db,stroke:#2471a3,color:#fff,rx:6

    subgraph P1["Partition: conversation_id = 42"]
        M1["seq 1"]:::msg --> M2["seq 2"]:::msg --> M3["seq 3"]:::msg --> M4["..."]:::msg
    end
    subgraph P2["Partition: conversation_id = 99"]
        N1["seq 1"]:::msg --> N2["seq 2"]:::msg --> N3["..."]:::msg
    end

    P1:::part
    P2:::part
```

**Scroll-back uses cursor-based pagination, not offset.** A chat client scrolling up through history is the textbook case from [api-design.md's pagination strategies](./api-design.md): `OFFSET 5000` forces the store to walk past 5,000 rows just to throw them away, and that cost grows the further back a user scrolls — exactly backwards from how chat is actually used, where old history is read rarely but is still expected to load fast when it is. A cursor (the sequence number of the oldest message already loaded) turns "give me the next page" into a direct, indexed `WHERE conversation_id = 42 AND seq < :cursor ORDER BY seq DESC LIMIT 50` — constant-time regardless of how far back the user has scrolled.

<div class="quiz-card">
  <p class="quiz-q">Why does chat history fit a time-series/log storage model better than a normalized relational one?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Because the access pattern is almost entirely append (new messages) and ordered read (scroll-back within one conversation), with essentially no in-place updates to old rows — the same shape as a time-series log, not the update-heavy, join-heavy shape relational schemas are optimized for. Partitioning by conversation_id and ordering by sequence number lines storage up with exactly how the data is actually read: recent-first, within one conversation, rarely touching anything already written.</div>
</div>

---

## 10. Delivery / Read Receipts

A message's status isn't one flag — it's a **per-recipient-device state machine**. In a group chat, one message can simultaneously be "read" on Alice's phone, "delivered but unread" on Bob's laptop, and "sent but not yet delivered" to Carol's phone, which is offline. The three states only ever move forward:

```mermaid
stateDiagram-v2
    [*] --> Sent: Client transmits, server accepts and persists
    Sent --> Delivered: Recipient device's client acknowledges receipt over its live connection
    Delivered --> Read: Recipient opens the conversation and views the message
    Sent --> [*]
    Delivered --> [*]
    Read --> [*]

    note right of Sent
        Server has the message durably stored.
        Recipient device may still be offline.
    end note
    note right of Delivered
        Recipient's device has the bytes.
        Says nothing about whether a human looked at it.
    end note
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Sent.</strong> The message hits the server and is durably persisted (Section 9) — this is the state the sender sees the instant their own send succeeds, and it says nothing yet about the recipient's device.
    </div>
    <div class="stepper-panel">
      <strong>2. Delivered.</strong> The recipient's device receives the message over its live connection and sends back a delivery acknowledgment. If the recipient has no active connection, the message stays at "sent" until reconnect or offline push (Section 11) — delivery is device-specific, so a 3-device user can have this state differ per device at the same instant.
    </div>
    <div class="stepper-panel">
      <strong>3. Read.</strong> The recipient's client marks the message read once it's actually rendered on screen (typically when the conversation is opened, sometimes gated further on scroll position). This is a separate signal the client has to send explicitly — the server has no way to infer "a human looked at this" from delivery alone.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

In a group of N people, one message needs N independent receipt records (one per member, per their own devices) — "delivered" for a group message usually means "delivered to at least one of that member's devices," while some clients track it per-device for finer-grained UI. Either way, receipts are always evaluated relative to a specific recipient, never as one global status on the message itself.

<div class="quiz-card">
  <p class="quiz-q">A message shows "delivered" to a recipient. Does that guarantee a human has seen it?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. "Delivered" only means the recipient's device received the bytes over its connection and acknowledged that — the message could be sitting unread in a notification tray or an unopened app. "Read" is a separate, later transition that only fires once the client explicitly signals the message was actually rendered on screen; the server can't infer it from delivery.</div>
</div>

---

## 11. Offline Delivery via Push Notifications

Sections 3–8 all assume the recipient has a live WebSocket connection somewhere. They often don't — phone is locked, app is killed, laptop is asleep. When the connection registry lookup from Section 3 comes back empty for every one of a user's known devices, the gateway can't push at all, so it hands off to a **push notification service** (APNs for iOS, FCM for Android/web).

The critical detail: the push notification is a wake-up trigger, not the message's system of record. The message must already be durably written to the persistent store (Section 9) *before* the push is sent — the push payload is typically just a hint ("new message from Alice") that opens the app, which then fetches the real message from the store, complete with its proper sequence number and full content. If the store write happened only after the push succeeded, a crash between the two would leave a notification the user tapped on pointing at nothing.

```mermaid
sequenceDiagram
    participant Sender
    participant GW as Gateway
    participant Store as Persistent store
    participant Reg as Connection registry
    participant Push as Push service, APNs or FCM
    participant Device as Recipient's phone, no active connection

    Sender->>GW: send message
    GW->>Store: persist message, assign seq (durable first, always)
    Store-->>GW: persisted ok
    GW->>Reg: lookup recipient's connections
    Reg-->>GW: no active connection on any device
    GW->>Push: send notification, hint only, not the full message
    Push->>Device: wake app via OS push
    Note over Device: user opens the app
    Device->>Store: fetch messages since last_seen seq
    Store-->>Device: full message content, correctly ordered
```

This also means offline delivery and the ordering/gap-detection mechanism from Section 5 are the same code path: a device that was offline for hours reconnects, notices its `last_seen` sequence number is far behind, and backfills the gap from the persistent store exactly like a device recovering from a brief network blip — offline for 10 seconds and offline for 10 hours are the same recovery mechanism at different scale, not two different mechanisms.

<div class="quiz-card">
  <p class="quiz-q">Could the system skip writing to the persistent store for an offline user and just rely on the push notification payload carrying the message content?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No — push payloads are small, not guaranteed to be delivered (the OS can drop or coalesce them), and carry no ordering or gap-recovery mechanism of their own. If the message only ever lived in the push payload, a dropped notification would mean the message is simply gone with no way to detect or recover it. Persisting first, and treating the push purely as a wake-up hint that triggers a fetch from the durable store, is what makes offline delivery reliable instead of best-effort.</div>
</div>

---

## 12. Putting It Together — End-to-End Architecture

Every piece above is one layer of the same pipeline. None of them work in isolation — the gateway needs the registry to relay, the relay needs the store to actually deliver something durable, and the whole system needs the presence and push layers to cover the gap when a client isn't live.

```mermaid
graph TD
    classDef client fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:6
    classDef gw fill:#3498db,stroke:#2471a3,color:#fff,rx:6
    classDef bus fill:#e67e22,stroke:#ba6018,color:#fff,rx:6
    classDef store fill:#2c3e50,stroke:#1a252f,color:#fff,rx:6
    classDef presence fill:#8e44ad,stroke:#6c3483,color:#fff,rx:6
    classDef push fill:#27ae60,stroke:#1e8449,color:#fff,rx:6

    subgraph CLIENTS["Clients — N devices per user"]
        C1["Phone"]:::client
        C2["Laptop"]:::client
        C3["Web tab"]:::client
    end

    subgraph GATEWAY["WebSocket gateway cluster — stateless-ish, horizontally scaled"]
        GW1["Gateway 1"]:::gw
        GW2["Gateway 2"]:::gw
        GW3["Gateway 3"]:::gw
    end

    subgraph RELAY["Message broker / pub-sub relay"]
        BUS["Redis Pub/Sub or Kafka<br/>one channel per gateway"]:::bus
        REG["Connection registry<br/>user_id to server_id, connection_id"]:::bus
    end

    subgraph STORAGE["Persistent message store"]
        LOG["Append-only per-conversation log<br/>partitioned by conversation_id, ordered by seq"]:::store
    end

    subgraph PRESENCE["Presence service"]
        PRES["Redis: presence:user_id, TTL-refreshed by heartbeat"]:::presence
    end

    subgraph OFFLINE["Push notification service — offline users only"]
        PUSH["APNs / FCM dispatcher"]:::push
    end

    C1 & C2 & C3 -->|"WebSocket"| GW1 & GW2 & GW3
    GW1 & GW2 & GW3 <-->|"lookup / register / heartbeat"| REG
    GW1 & GW2 & GW3 <-->|"publish / subscribe per gateway channel"| BUS
    GW1 & GW2 & GW3 -->|"persist every message before relay completes"| LOG
    GW1 & GW2 & GW3 <-->|"heartbeat refresh, presence reads"| PRES
    REG -.->|"lookup returns no live connection"| PUSH
    PUSH -.->|"wake-up notification only"| C1
    LOG -.->|"client fetches full content after waking"| C1
```

Trace one message through the whole thing: it lands on a gateway, gets persisted to the log with a sequence number (Section 9) before anything else happens, gets deduped and acked for delivery guarantees (Section 4), gets relayed via the registry and pub/sub to every one of the recipient's connected devices (Sections 3 and 7) — falling back to push for any device the registry shows as offline (Section 11) — and along the way updates delivery/read receipts (Section 10) and each participant's presence (Section 6). Group and broadcast conversations pick fan-out-on-write or fan-out-on-read (Section 8) at the relay step depending on member count. Every layer here is independently scalable — you can add gateway servers without touching the store, or reshard the store without touching the gateways — because none of them hold state the others depend on beyond what's in the registry and the log.

<div class="quiz-card">
  <p class="quiz-q">In this architecture, if the persistent message store were slow or down, would relaying messages to already-connected recipients still work?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>It shouldn't be allowed to "work" in a way that skips the store — the diagram's relay step explicitly persists every message before the relay completes, precisely so a message that reached a live recipient's screen is never only living in an in-memory pub/sub hop. If the store is down, correct behavior is to fail or queue the send, not relay first and persist later — otherwise a gateway crash right after an in-memory relay would lose the message with no durable copy anywhere, the same durability gap Section 11 calls out for offline push.</div>
</div>

---

## Quick Reference

```
Server can't push without being asked      → persistent connection (WebSocket/SSE/long-poll)
Need low-latency bidirectional messaging   → WebSocket
Need one-way push, proxy-friendly          → Server-Sent Events
WebSocket blocked by network               → long-polling fallback
Reach a user connected to another server   → connection registry + pub/sub relay
Prevent duplicate messages on retry        → client-generated message ID + dedup store
Detect and recover missed messages         → per-conversation sequence number + gap backfill
Online/offline without explicit signaling  → heartbeat + TTL key, eventually consistent
Reach every one of a user's devices        → registry as user_id to list of connections
Small group message fan-out                → fan-out-on-write, push to every member
Huge broadcast channel fan-out             → fan-out-on-read, per-subscriber last-read pointer
Fast scroll-back through history           → cursor-based pagination, not OFFSET
Per-recipient message status               → sent → delivered → read state machine
Recipient has no active connection         → persist first, then hand off to APNs/FCM
```
