# gRPC Deep Dive

Implementation-level gRPC: wire format, streaming modes with full code, HTTP/2 mechanics, interceptors, deadlines, health checking, load balancing, gRPC-Web, and error handling. Conceptual overview lives in [grpc-graphql.md](./grpc-graphql.md) — this file goes underneath it.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## 1. Protobuf Wire Format Internals

Every field on the wire is a **tag-value pair**. The tag encodes both the field number and the wire type in a single varint.

```
tag = (field_number << 3) | wire_type
```

| Wire type | ID | Used for |
|-----------|-----|----------|
| Varint | 0 | int32, int64, uint32, uint64, sint32/64, bool, enum |
| 64-bit | 1 | fixed64, sfixed64, double |
| Length-delimited | 2 | string, bytes, embedded messages, packed repeated fields |
| Start group / End group | 3 / 4 | deprecated, unused in proto3 |
| 32-bit | 5 | fixed32, sfixed32, float |

### Varint encoding

Each byte uses 7 bits for data + 1 continuation bit (MSB). Small numbers cost 1 byte; large numbers cost more.

```
Encoding 300 as a varint:
300 = 0b100101100

Split into 7-bit groups (LSB first): 0101100  0000010
Set continuation bit on all but the last byte:
  byte 0: 1_0101100  -> 0xAC   (continuation bit set, more bytes follow)
  byte 1: 0_0000010  -> 0x02   (final byte)

Wire bytes: AC 02
```

```protobuf
message Order {
  string id = 1;        // tag = (1 << 3) | 2 = 0x0A (length-delimited)
  double amount = 3;     // tag = (3 << 3) | 1 = 0x19 (64-bit)
  int32 quantity = 4;    // tag = (4 << 3) | 0 = 0x20 (varint)
}
```

Encoding `Order{id: "A1", amount: 9.5, quantity: 300}`:

```
0A 02 41 31          # tag=0x0A (field 1, len-delim), length=2, bytes "A1"
19 00 00 00 00 00 00 23 40   # tag=0x19 (field 3, 64-bit), IEEE754 double 9.5
20 AC 02             # tag=0x20 (field 4, varint), varint(300) = AC 02
```

**Why this is smaller than JSON:** no field names on the wire (just numeric tags), no delimiters/whitespace, numbers use variable-length encoding instead of ASCII digits.

### Message size prefixing over HTTP/2

gRPC frames each message with a 5-byte prefix before handing it to HTTP/2 DATA frames — this is the **Length-Prefixed Message** format defined by the gRPC wire protocol, independent of protobuf itself:

```mermaid
graph LR
    classDef flag fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef len fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef msg fill:#27ae60,stroke:#1e8449,color:#fff,rx:8

    F["Compressed Flag — 1 byte<br>0x00 = identity (uncompressed)<br>0x01 = compressed per grpc-encoding header"]:::flag
    L["Message Length — 4 bytes<br>big-endian uint32<br>exact byte count of the message that follows"]:::len
    M["Message — N bytes<br>protobuf-encoded payload<br>(or compressed bytes if flag=1)"]:::msg

    F --> L --> M
```

This lets a receiver read exactly N bytes for one message even when several messages arrive back-to-back inside a single HTTP/2 DATA frame (frames don't align 1:1 with RPC messages — a large message can span multiple DATA frames, or several small messages can pack into one).

```
HTTP/2 DATA frame payload for a streamed response:
[00][00 00 00 0C][... 12 bytes of Order protobuf ...][00][00 00 00 08][... 8 bytes ...]
 ^compressed=no  ^length=12                            ^flag        ^length=8
```

<div class="quiz-card">
  <p class="quiz-q">A single HTTP/2 DATA frame arrives containing two back-to-back gRPC messages. How does the receiver know where the first message ends and the second begins, given that DATA frames don't align 1:1 with RPC messages?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>The 5-byte length-prefix in front of every message. The receiver reads the 1-byte compressed flag and 4-byte big-endian length, consumes exactly that many bytes as the first message, then repeats the same read for whatever bytes remain — it never has to guess a boundary from the protobuf content itself. This is exactly what lets several small messages pack into one DATA frame, or a single large message span several frames.</div>
</div>

---

## 2. The 4 Streaming Modes — Full Proto + Go Code

```protobuf
syntax = "proto3";
package order.v1;
option go_package = "example.com/order/v1;orderv1";

service OrderService {
  rpc GetOrder(GetOrderRequest) returns (Order);                         // unary
  rpc ListOrders(ListOrdersRequest) returns (stream Order);              // server streaming
  rpc BulkCreate(stream CreateOrderRequest) returns (BulkCreateResponse); // client streaming
  rpc Chat(stream ChatMessage) returns (stream ChatMessage);             // bidi streaming
}

message GetOrderRequest { string order_id = 1; }
message ListOrdersRequest { string customer_id = 1; }
message CreateOrderRequest { string customer_id = 1; double amount = 2; }
message BulkCreateResponse { int32 created_count = 1; repeated string order_ids = 2; }
message ChatMessage { string from = 1; string text = 2; }

message Order {
  string id = 1;
  string customer_id = 2;
  double amount = 3;
}
```

Quick side-by-side before the full code for each — cardinality, the call shape, and how each side knows the stream is done:

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="unary" class="active">Unary</button>
    <button data-tab="serverstream">Server streaming</button>
    <button data-tab="clientstream">Client streaming</button>
    <button data-tab="bidistream">Bidi streaming</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="unary">
      <strong>1 request → 1 response.</strong> The handler signature is a plain function: takes a request, returns a response or an error. No stream object at all. Termination is implicit — the function returning <em>is</em> the end of the RPC.
    </div>
    <div class="tab-panel" data-tab-panel="serverstream">
      <strong>1 request → N responses.</strong> The client sends one message; the server calls <code>stream.Send()</code> in a loop. The client's <code>stream.Recv()</code> loop ends when it sees <code>io.EOF</code> — the server signals "done" simply by returning <code>nil</code> from its handler.
    </div>
    <div class="tab-panel" data-tab-panel="clientstream">
      <strong>N requests → 1 response.</strong> The client calls <code>stream.Send()</code> in a loop, then <code>stream.CloseAndRecv()</code> to signal it's finished and block for the aggregate response. The server's <code>stream.Recv()</code> loop detects <code>io.EOF</code> and replies once via <code>stream.SendAndClose()</code>.
    </div>
    <div class="tab-panel" data-tab-panel="bidistream">
      <strong>N requests ↔ N responses, independently.</strong> Both sides send and receive on their own schedule — nothing forces a request/response pairing. The client's <code>stream.CloseSend()</code> is a <em>half-close</em>: it stops the client from sending more, but the server can keep replying until it independently decides to return.
    </div>
  </div>
</div>

### 2.1 Unary — one request, one response

```go
// Server
func (s *server) GetOrder(ctx context.Context, req *orderv1.GetOrderRequest) (*orderv1.Order, error) {
    order, ok := s.db[req.OrderId]
    if !ok {
        return nil, status.Errorf(codes.NotFound, "order %s not found", req.OrderId)
    }
    return order, nil
}

// Client
resp, err := client.GetOrder(ctx, &orderv1.GetOrderRequest{OrderId: "abc123"})
if err != nil {
    st, _ := status.FromError(err)
    log.Printf("code=%s msg=%s", st.Code(), st.Message())
    return
}
fmt.Println(resp)
```

### 2.2 Server streaming — one request, stream of responses

```go
// Server
func (s *server) ListOrders(req *orderv1.ListOrdersRequest, stream orderv1.OrderService_ListOrdersServer) error {
    for _, order := range s.ordersFor(req.CustomerId) {
        if err := stream.Send(order); err != nil {
            return err // client disconnected or context cancelled
        }
    }
    return nil // returning nil closes the stream with status OK
}

// Client
stream, err := client.ListOrders(ctx, &orderv1.ListOrdersRequest{CustomerId: "cust-1"})
if err != nil {
    log.Fatal(err)
}
for {
    order, err := stream.Recv()
    if err == io.EOF {
        break // server closed the stream normally
    }
    if err != nil {
        log.Fatal(err)
    }
    fmt.Println(order)
}
```

### 2.3 Client streaming — stream of requests, one response

```go
// Server
func (s *server) BulkCreate(stream orderv1.OrderService_BulkCreateServer) error {
    var ids []string
    for {
        req, err := stream.Recv()
        if err == io.EOF {
            // client finished sending; send the single aggregate response
            return stream.SendAndClose(&orderv1.BulkCreateResponse{
                CreatedCount: int32(len(ids)),
                OrderIds:     ids,
            })
        }
        if err != nil {
            return err
        }
        id := s.create(req)
        ids = append(ids, id)
    }
}

// Client
stream, err := client.BulkCreate(ctx)
if err != nil {
    log.Fatal(err)
}
for _, order := range pendingOrders {
    if err := stream.Send(order); err != nil {
        log.Fatal(err)
    }
}
resp, err := stream.CloseAndRecv() // signals EOF to server, waits for the aggregate response
if err != nil {
    log.Fatal(err)
}
fmt.Println("created:", resp.CreatedCount)
```

### 2.4 Bidirectional streaming — full runnable example with context cancellation

```go
// server.go
package main

import (
    "context"
    "io"
    "log"
    "net"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"

    orderv1 "example.com/order/v1"
)

type chatServer struct {
    orderv1.UnimplementedOrderServiceServer
}

func (s *chatServer) Chat(stream orderv1.OrderService_ChatServer) error {
    ctx := stream.Context()

    // Independent goroutine reads incoming messages, feeds a channel
    incoming := make(chan *orderv1.ChatMessage)
    errCh := make(chan error, 1)

    go func() {
        for {
            msg, err := stream.Recv()
            if err == io.EOF {
                close(incoming)
                return
            }
            if err != nil {
                errCh <- err
                return
            }
            incoming <- msg
        }
    }()

    for {
        select {
        case <-ctx.Done():
            // Client disconnected, deadline exceeded, or server shutting down
            log.Printf("chat stream ended: %v", ctx.Err())
            return status.Error(codes.Canceled, "stream cancelled")

        case err := <-errCh:
            return err

        case msg, ok := <-incoming:
            if !ok {
                return nil // client closed send side cleanly, end the RPC
            }
            reply := &orderv1.ChatMessage{From: "server", Text: "echo: " + msg.Text}
            if err := stream.Send(reply); err != nil {
                return err
            }
        }
    }
}

func main() {
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        log.Fatal(err)
    }
    srv := grpc.NewServer()
    orderv1.RegisterOrderServiceServer(srv, &chatServer{})
    log.Println("listening on :50051")
    log.Fatal(srv.Serve(lis))
}
```

```go
// client.go
package main

import (
    "context"
    "io"
    "log"
    "time"

    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"

    orderv1 "example.com/order/v1"
)

func main() {
    conn, err := grpc.NewClient("localhost:50051", grpc.WithTransportCredentials(insecure.NewCredentials()))
    if err != nil {
        log.Fatal(err)
    }
    defer conn.Close()

    client := orderv1.NewOrderServiceClient(conn)

    // Deadline propagates as the grpc-timeout header, cancels the whole call chain
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    stream, err := client.Chat(ctx)
    if err != nil {
        log.Fatal(err)
    }

    // Send goroutine
    go func() {
        messages := []string{"hello", "how are you", "goodbye"}
        for _, text := range messages {
            if err := stream.Send(&orderv1.ChatMessage{From: "client", Text: text}); err != nil {
                log.Printf("send error: %v", err)
                return
            }
            time.Sleep(time.Second)
        }
        stream.CloseSend() // half-close: no more sends, server can still reply
    }()

    // Receive loop on the main goroutine
    for {
        msg, err := stream.Recv()
        if err == io.EOF {
            log.Println("stream closed by server")
            return
        }
        if err != nil {
            log.Printf("recv error: %v (ctx err: %v)", err, ctx.Err())
            return
        }
        log.Printf("received: %s", msg.Text)
    }
}
```

**Cancellation propagation:** cancelling `ctx` (timeout, explicit `cancel()`, or client process exit) tears down the underlying HTTP/2 stream — the server's `stream.Context().Done()` fires, and any blocked `stream.Recv()`/`stream.Send()` on both sides unblocks with an error. There is no leaked goroutine as long as both sides `select` on `ctx.Done()` as shown above.

<div class="quiz-card">
  <p class="quiz-q">In the bidi chat example, the client goroutine calls stream.CloseSend() after its last message. Does that end the RPC?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No — CloseSend() is a half-close. It tells the server "no more messages coming from me," but the server can keep sending replies on the same stream for as long as it wants. The RPC only fully ends when the server's handler returns (or the client's receive loop sees io.EOF after the server closes its side, or ctx is cancelled). Conflating "I'm done sending" with "the call is over" is the easiest mistake to make with bidi streams.</div>
</div>

---

## 3. gRPC over HTTP/2 Mechanics

```mermaid
graph TD
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef conn fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8

    CONN["Single TCP connection<br>one HTTP/2 connection, negotiated once<br>via ALPN during the TLS handshake"]:::conn

    subgraph MUX["Multiplexed streams — no head-of-line blocking between them"]
        S1["Stream 1: RPC call A<br>HEADERS + DATA + trailing HEADERS<br>client-initiated, odd-numbered"]:::purple
        S2["Stream 3: RPC call B<br>concurrent, independent frames<br>interleaved with Stream 1 and 5"]:::purple
        S3["Stream 5: streaming RPC C<br>long-lived, many DATA frames<br>over the RPC's whole lifetime"]:::orange
    end

    CONN --> S1
    CONN --> S2
    CONN --> S3
```

Each RPC call is **one HTTP/2 stream** (odd-numbered, client-initiated). Multiple RPCs multiplex over a single TCP connection with no head-of-line blocking between streams — this is the mechanism, not an add-on.

**Why gRPC requires HTTP/2, not HTTP/1.1:**

| Requirement | HTTP/1.1 | HTTP/2 |
|---|---|---|
| Full-duplex streaming on one connection | Not possible — one request/response per connection at a time (or pipelining, which is broken/unused) | Native — independent streams carry concurrent request/response bodies |
| Trailing metadata (`grpc-status`, `grpc-message` sent *after* the body) | No trailer support in practice | HEADERS frame can appear after DATA frames (trailers) |
| Multiplexing without head-of-line blocking | No — sequential or multiple TCP connections needed | Yes — frames from different streams interleave on one connection |
| Binary framing | Text-based, requires parsing line-by-line | Binary frames, structured length-prefixed |

gRPC's status is sent as **HTTP/2 trailers** — a second HEADERS frame after the DATA frames, containing `grpc-status` and `grpc-message`. This lets the server stream a full response body and only decide/report final status afterward — impossible in HTTP/1.1, which has no trailer mechanism outside of chunked encoding (which is barely supported and never used this way).

**Header compression (HPACK):** gRPC calls carry repetitive headers on every request (`content-type: application/grpc`, `grpc-timeout`, `grpc-encoding`, auth tokens). HTTP/2's HPACK maintains a per-connection dynamic table so repeated header values are sent as small index references after the first occurrence instead of full strings every time — meaningful savings at high RPC rates where header overhead would otherwise dominate small messages.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: Stream lifecycle for one unary RPC (HTTP/2 stream 1)
    C->>S: HEADERS (:method POST, :path /order.v1.OrderService/GetOrder,<br>grpc-timeout: 5S, content-type: application/grpc)
    C->>S: DATA (length-prefixed protobuf request)
    Note over C: Client's half of the stream ends implicitly<br>after the last DATA frame (END_STREAM)
    Note over S: Server processes the request
    S->>C: HEADERS (:status 200, content-type: application/grpc)
    S->>C: DATA (length-prefixed protobuf response)
    S->>C: HEADERS, END_STREAM=true (trailers: grpc-status: 0, grpc-message: "")
    Note over C,S: Trailers are what let the server report final status<br>only after the response body has already streamed
```

<div class="quiz-card">
  <p class="quiz-q">Why can't HTTP/1.1 carry grpc-status the way HTTP/2 does, and why does that specifically break streaming RPCs?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>HTTP/2 lets a HEADERS frame appear after the DATA frames as trailers — HTTP/1.1 has no real trailer mechanism outside chunked encoding, which is barely supported and never used this way. That matters for streaming specifically because the server doesn't know its final grpc-status until after it's already sent some (or all) of the response body — with no trailer support, there'd be nowhere left to put the status once the body has started streaming.</div>
</div>

---

## 4. gRPC Interceptors

Interceptors wrap RPC handling for cross-cutting concerns — the gRPC equivalent of HTTP middleware.

### 4.1 Unary auth interceptor

```go
package interceptors

import (
    "context"

    "google.golang.org/grpc"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/metadata"
    "google.golang.org/grpc/status"
)

func AuthUnaryInterceptor(validTokens map[string]bool) grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        md, ok := metadata.FromIncomingContext(ctx)
        if !ok {
            return nil, status.Error(codes.Unauthenticated, "missing metadata")
        }

        tokens := md.Get("authorization")
        if len(tokens) == 0 {
            return nil, status.Error(codes.Unauthenticated, "missing authorization header")
        }

        if !validTokens[tokens[0]] {
            return nil, status.Error(codes.PermissionDenied, "invalid token")
        }

        // Attach validated identity into context for downstream handlers
        ctx = context.WithValue(ctx, "authenticated", true)
        return handler(ctx, req) // proceed to the actual RPC method
    }
}
```

### 4.2 Prometheus metrics interceptor (unary + stream)

```go
package interceptors

import (
    "context"
    "time"

    "github.com/prometheus/client_golang/prometheus"
    "google.golang.org/grpc"
    "google.golang.org/grpc/status"
)

var (
    rpcDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
        Name:    "grpc_server_handling_seconds",
        Help:    "Response latency for gRPC calls",
        Buckets: prometheus.DefBuckets,
    }, []string{"grpc_method", "grpc_code"})

    rpcInFlight = prometheus.NewGaugeVec(prometheus.GaugeOpts{
        Name: "grpc_server_in_flight_requests",
        Help: "Number of in-flight gRPC requests",
    }, []string{"grpc_method"})
)

func init() {
    prometheus.MustRegister(rpcDuration, rpcInFlight)
}

func MetricsUnaryInterceptor() grpc.UnaryServerInterceptor {
    return func(
        ctx context.Context,
        req interface{},
        info *grpc.UnaryServerInfo,
        handler grpc.UnaryHandler,
    ) (interface{}, error) {
        rpcInFlight.WithLabelValues(info.FullMethod).Inc()
        defer rpcInFlight.WithLabelValues(info.FullMethod).Dec()

        start := time.Now()
        resp, err := handler(ctx, req)
        code := status.Code(err)

        rpcDuration.WithLabelValues(info.FullMethod, code.String()).Observe(time.Since(start).Seconds())
        return resp, err
    }
}

// Stream interceptor wraps the ServerStream to intercept per-message calls or just measure total call duration
func MetricsStreamInterceptor() grpc.StreamServerInterceptor {
    return func(
        srv interface{},
        ss grpc.ServerStream,
        info *grpc.StreamServerInfo,
        handler grpc.StreamHandler,
    ) error {
        rpcInFlight.WithLabelValues(info.FullMethod).Inc()
        defer rpcInFlight.WithLabelValues(info.FullMethod).Dec()

        start := time.Now()
        err := handler(srv, ss)
        code := status.Code(err)

        rpcDuration.WithLabelValues(info.FullMethod, code.String()).Observe(time.Since(start).Seconds())
        return err
    }
}
```

```go
// Wiring both into the server
srv := grpc.NewServer(
    grpc.ChainUnaryInterceptor(
        interceptors.AuthUnaryInterceptor(validTokens),
        interceptors.MetricsUnaryInterceptor(),
    ),
    grpc.ChainStreamInterceptor(
        interceptors.MetricsStreamInterceptor(),
    ),
)
```

Interceptor execution order with `ChainUnaryInterceptor` is left-to-right on the way in (auth runs before metrics, so unauthenticated calls don't pollute latency histograms) and right-to-left unwinding on the way out.

<div class="quiz-card">
  <p class="quiz-q">grpc.ChainUnaryInterceptor(AuthUnaryInterceptor(...), MetricsUnaryInterceptor()) is wired in that order. Does the metrics interceptor record latency for a request that fails auth?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. Chained interceptors run left-to-right on the way in, so auth executes first and returns an Unauthenticated error immediately — handler(ctx, req) inside the auth interceptor is never called, which means MetricsUnaryInterceptor (listed second) never even starts, let alone records a duration. Swap the order and every unauthenticated call would pollute the latency histograms instead.</div>
</div>

---

## 5. Deadline Propagation

A Go `context.Context` deadline serializes to the **`grpc-timeout` request header** on the wire. This is what makes deadlines cascade automatically across a call chain without manual bookkeeping.

```mermaid
sequenceDiagram
    participant A as Service A (gateway)
    participant B as Service B (order)
    participant C as Service C (inventory)

    rect rgb(40, 55, 75)
    Note over A: Budget set once, at the top of the call chain
    A->>A: ctx, cancel := context.WithTimeout(ctx, 5s)
    A->>B: gRPC call, header: grpc-timeout: 5000m (5s remaining)
    end

    rect rgb(55, 45, 30)
    Note over B: 1.2s elapsed processing so far —<br>this is time A's budget is paying for
    B->>C: forwards ctx (derived), header: grpc-timeout: 3800m (~3.8s remaining)
    Note over C: C only gets what's left of A's original budget,<br>not a fresh 5s of its own
    end

    alt C responds in time
        C-->>B: response, well inside the ~3.8s it was handed
        B-->>A: response, well inside A's original 5s
    else C (or B) blows through the remaining budget
        C-->>B: DEADLINE_EXCEEDED — C's ctx.Done() fired mid-work
        B-->>A: propagated DEADLINE_EXCEEDED — B didn't invent a new error, it forwarded C's
    end
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Service A sets the top-level budget.</strong> <code>context.WithTimeout(context.Background(), 5*time.Second)</code> — this is the only place in the chain where a fresh 5-second budget is created from nothing.
    </div>
    <div class="stepper-panel">
      <strong>2. The budget serializes onto the wire.</strong> gRPC turns the context's remaining deadline into a <code>grpc-timeout: 5000m</code> request header on the call to Service B — the header <em>is</em> the propagation mechanism, not something the application code manages by hand.
    </div>
    <div class="stepper-panel">
      <strong>3. Service B derives, never replaces.</strong> B's handler receives a ctx that already carries A's countdown, minus whatever time has already elapsed. As long as B calls <code>context.WithTimeout(ctx, ...)</code> — deriving from the incoming ctx — the downstream call to C can only ever get <code>min(B's own timeout, A's remaining time)</code>.
    </div>
    <div class="stepper-panel">
      <strong>4. Service C gets what's left, not a fresh clock.</strong> By the time the request reaches C, network latency and B's own processing have already eaten into A's original 5 seconds. C's <code>grpc-timeout</code> header reflects that — roughly 3.8s remaining, not 5.
    </div>
    <div class="stepper-panel">
      <strong>5. Either everyone finishes, or the failure propagates as one signal.</strong> If C blows through its remaining budget, its own ctx fires <code>DEADLINE_EXCEEDED</code>; B doesn't reinterpret that as a different error, it forwards the same code back to A. One budget, one consistent failure mode across the whole chain.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

```go
// Service A — sets the top-level budget
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
resp, err := serviceBClient.PlaceOrder(ctx, req)

// Service B — MUST forward the same ctx (or a derived one), not create a fresh context
func (s *server) PlaceOrder(ctx context.Context, req *PlaceOrderRequest) (*PlaceOrderResponse, error) {
    // ctx here already carries A's remaining deadline, minus network + processing time so far
    invResp, err := s.inventoryClient.CheckStock(ctx, &CheckStockRequest{Sku: req.Sku})
    if err != nil {
        if status.Code(err) == codes.DeadlineExceeded {
            return nil, status.Error(codes.DeadlineExceeded, "upstream inventory check timed out")
        }
        return nil, err
    }
    // ...
}
```

**Cascading behavior:** if Service B creates a *new* independent `context.WithTimeout(context.Background(), 5*time.Second)` instead of deriving from the incoming `ctx`, it silently breaks the budget — C could get a fresh 5s even though A's original 5s is nearly exhausted, causing A to time out and abandon the call while B and C keep working. Always derive downstream contexts from the incoming one:

```go
// WRONG — resets the deadline, breaks cascading
ctx2, cancel := context.WithTimeout(context.Background(), 5*time.Second)

// CORRECT — inherits and can only shrink the remaining deadline, never extend it
ctx2, cancel := context.WithTimeout(ctx, 2*time.Second) // capped at min(2s, ctx's remaining time)
```

`grpc-timeout` header format is a number + unit suffix: `H` (hours), `M` (minutes), `S` (seconds), `m` (milliseconds), `u` (microseconds), `n` (nanoseconds) — e.g. `5000m` = 5000 milliseconds.

<div class="quiz-card">
  <p class="quiz-q">Service B receives a request from A with 3.8s left on the deadline. B calls context.WithTimeout(ctx, 10*time.Second) before forwarding to Service C. How much time does C actually get?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>~3.8s, not 10s. Deriving from ctx means the new deadline is capped at min(the new duration, ctx's remaining time) — a derived context can only shrink the deadline it inherited, never extend it. The 10*time.Second argument only matters if it's shorter than what's left; here it's longer, so A's original budget still wins. This is different from the WRONG example in the file, which creates a fresh context.Background() instead of deriving — that would actually hand C a full new 10s, silently breaking the cascade.</div>
</div>

---

## 6. gRPC Health Checking Protocol

Standard proto (`grpc.health.v1.Health`) — not something you invent per-service:

```protobuf
// grpc/health/v1/health.proto (part of grpc-proto, well-known)
service Health {
  rpc Check(HealthCheckRequest) returns (HealthCheckResponse);
  rpc Watch(HealthCheckRequest) returns (stream HealthCheckResponse);
}

message HealthCheckRequest {
  string service = 1; // empty string = overall server health
}

message HealthCheckResponse {
  enum ServingStatus {
    UNKNOWN = 0;
    SERVING = 1;
    NOT_SERVING = 2;
    SERVICE_UNKNOWN = 3;
  }
  ServingStatus status = 1;
}
```

```go
import "google.golang.org/grpc/health"
import healthpb "google.golang.org/grpc/health/grpc_health_v1"

healthServer := health.NewServer()
healthpb.RegisterHealthServer(grpcServer, healthServer)

// Liveness: process is alive at all — set once at startup
healthServer.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

// Readiness: per-dependency granularity — flip when a specific downstream is unavailable
healthServer.SetServingStatus("order.v1.OrderService", healthpb.HealthCheckResponse_NOT_SERVING)
```

| Semantic | Maps to | Behavior |
|---|---|---|
| Liveness | `Check("")` — overall server status | K8s liveness probe uses this: if `NOT_SERVING`, container gets restarted |
| Readiness | `Check("<specific-service>")` | K8s readiness probe: if `NOT_SERVING`, pod removed from Service endpoints but not restarted |
| `Watch` | Streaming variant | Client-side load balancers subscribe instead of polling `Check` repeatedly |

```mermaid
sequenceDiagram
    participant DEP as Downstream dependency
    participant SRV as order.v1.OrderService (mongod down!)
    participant HS as grpc.health.v1.Health server
    participant K8S as Kubernetes kubelet
    participant LB as Client-side LB (Watch subscriber)

    Note over SRV,HS: Startup — process alive, dependency not yet checked
    SRV->>HS: SetServingStatus("", SERVING)
    Note over SRV,HS: Liveness now reports healthy for the whole process

    loop kubelet liveness probe, every periodSeconds
        K8S->>HS: Check("")
        HS-->>K8S: SERVING
        Note over K8S: Container stays up
    end

    par LB subscribes once, not polling
        LB->>HS: Watch("order.v1.OrderService")
        HS-->>LB: stream: SERVING
    end

    DEP--xSRV: dependency connection lost
    SRV->>HS: SetServingStatus("order.v1.OrderService", NOT_SERVING)
    HS-->>LB: stream push: NOT_SERVING (no poll needed — Watch is a live stream)
    Note over LB: Client-side LB stops routing new RPCs to this backend

    K8S->>HS: Check("order.v1.OrderService") — readiness probe
    HS-->>K8S: NOT_SERVING
    Note over K8S: Pod pulled from Service endpoints,<br>but container is NOT restarted — only readiness failed, not liveness
```

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Process starts, liveness flips to SERVING.</strong> <code>SetServingStatus("", SERVING)</code> answers one question only: "is this process alive at all." It says nothing about whether any particular dependency works yet.
    </div>
    <div class="stepper-panel">
      <strong>2. kubelet polls liveness on a timer.</strong> Every <code>periodSeconds</code>, kubelet calls <code>Check("")</code>. As long as it gets back <code>SERVING</code>, the container is left alone — liveness is a "should this container be restarted" signal, nothing finer-grained.
    </div>
    <div class="stepper-panel">
      <strong>3. Interested clients Watch instead of polling.</strong> A client-side load balancer subscribes once via the streaming <code>Watch</code> RPC and gets pushed updates as they happen — no repeated round-trips just to notice a status change.
    </div>
    <div class="stepper-panel">
      <strong>4. A downstream dependency dies; readiness flips independently of liveness.</strong> <code>SetServingStatus("order.v1.OrderService", NOT_SERVING)</code> only affects that specific service name — the overall process (<code>""</code>) can stay <code>SERVING</code> the entire time, because the process itself hasn't crashed.
    </div>
    <div class="stepper-panel">
      <strong>5. Two different reactions to the same flip.</strong> The Watch subscriber (the load balancer) reacts immediately via the pushed stream update. Kubernetes' separate readiness probe eventually polls <code>Check("order.v1.OrderService")</code>, sees <code>NOT_SERVING</code>, and removes the pod from the Service's endpoint list — without touching liveness, so the container is never restarted for a problem a restart wouldn't fix.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

```yaml
# Kubernetes probe using grpc_health_probe binary (or native grpc probe in K8s 1.24+)
livenessProbe:
  grpc:
    port: 50051
readinessProbe:
  grpc:
    port: 50051
    service: "order.v1.OrderService"
```

```bash
# Manual check with grpcurl
grpcurl -plaintext localhost:50051 grpc.health.v1.Health/Check
grpcurl -plaintext -d '{"service": "order.v1.OrderService"}' localhost:50051 grpc.health.v1.Health/Check
```

<div class="quiz-card">
  <p class="quiz-q">A pod's MongoDB connection drops. The service calls SetServingStatus("order.v1.OrderService", NOT_SERVING) but never touches SetServingStatus("", ...). Does Kubernetes restart the container?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. The liveness probe checks Check("") — the overall process status — which is untouched and still SERVING. Only the readiness probe, which checks the specific service name, sees NOT_SERVING; that pulls the pod out of the Service's endpoints (so it stops receiving new traffic) without restarting it. Restarting a healthy process wouldn't fix a dead database connection anyway — that's exactly why liveness and readiness are tracked as two separate signals in this protocol.</div>
</div>

---

## 7. gRPC Load Balancing

### Client-side load balancing modes

```mermaid
graph LR
    classDef client fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8

    subgraph PF["pick_first — one sticky connection"]
        C1["Client (pick_first)<br>default policy, no config needed"]:::client -->|"every RPC, forever<br>(until this backend fails)"| S1["Backend 1<br>only connection ever opened"]:::orange
    end

    subgraph RR["round_robin — one connection per resolved address"]
        C2["Client (round_robin)<br>opt-in via service config"]:::client -->|"RPC 1, 4, 7, ..."| S1b["Backend 1"]:::blue
        C2 -->|"RPC 2, 5, 8, ..."| S2b["Backend 2"]:::blue
        C2 -->|"RPC 3, 6, 9, ..."| S3b["Backend 3"]:::blue
    end
```

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="pickfirst" class="active state-warn">pick_first (default)</button>
    <button data-toggle-opt="roundrobin" class="state-ok">round_robin</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="pickfirst">
    Connects to the first address the resolver returns and sends every RPC there until that connection fails. Cheapest option (one connection total) and gRPC's default with zero configuration — but it means all traffic sticks to a single backend for the connection's entire lifetime, which is exactly the failure mode that surprises people expecting even spread across a resolved backend set.
  </div>
  <div class="toggle-panel" data-toggle-panel="roundrobin">
    Opens a connection to <em>every</em> resolved backend up front, then distributes RPCs round-robin across all of them. Opt-in via <code>loadBalancingConfig</code> in the service config (shown below) — this is the policy that actually spreads load the way people assume gRPC does by default.
  </div>
</div>

```go
conn, err := grpc.NewClient(
    "dns:///order-service.internal:50051",
    grpc.WithDefaultServiceConfig(`{"loadBalancingConfig": [{"round_robin":{}}]}`),
    grpc.WithTransportCredentials(insecure.NewCredentials()),
)
```

### Why gRPC load balancing differs from HTTP/1.1 — and why L4 LBs fail here

An L4 (TCP-level) load balancer distributes **connections**, not requests. HTTP/1.1 typically opens many short-lived connections, so L4 balancing naturally spreads load. gRPC deliberately reuses a **single long-lived HTTP/2 connection** for many multiplexed RPCs — an L4 LB balances that one connection to one backend, and every RPC on it goes to the same backend for the connection's lifetime. Ten gRPC clients each holding one persistent connection to a 3-backend L4-balanced target commonly produces wildly uneven load (e.g., all 10 pinned to 1-2 backends) rather than an even 3-way split.

```mermaid
graph TD
    classDef client fill:#2c3e50,stroke:#1a252f,color:#fff,rx:8
    classDef lb fill:#8e44ad,stroke:#6c3483,color:#fff,rx:8
    classDef hot fill:#e74c3c,stroke:#c0392b,color:#fff,rx:8
    classDef cold fill:#7f8c8d,stroke:#616a6b,color:#fff,rx:8

    subgraph CLIENTS["10 gRPC clients, each holding one persistent HTTP/2 connection"]
        CL["10 clients"]:::client
    end

    CL --> L4["L4 (TCP-level) load balancer<br>balances CONNECTIONS, not RPCs —<br>picks a backend once per connection, then never revisits it"]:::lb

    L4 -->|"7 connections pinned here"| B1["Backend 1<br>overloaded"]:::hot
    L4 -->|"3 connections pinned here"| B2["Backend 2<br>overloaded"]:::hot
    L4 -.->|"0 connections — added after clients<br>already connected elsewhere"| B3["Backend 3<br>~0 traffic until connections cycle"]:::cold
```

**Solutions, in increasing sophistication:**

| Approach | Mechanism | Tradeoff |
|---|---|---|
| Client-side `round_robin` + DNS resolver | Client opens a connection per resolved backend IP, spreads RPCs itself | Requires client cooperation; DNS TTL/refresh lag on backend set changes |
| gRPC-aware L7 LB (e.g. Envoy, Linkerd) | Proxy terminates HTTP/2 from client, re-multiplexes RPCs across backend connections it manages | Proxy hop adds latency; needs sidecar or dedicated proxy tier |
| xDS (client-side, via Envoy's control plane API) | Client speaks xDS to a control plane, gets live backend endpoint updates, load balances itself without a proxy in the data path | No extra hop, but requires xDS-capable client stack (gRPC's built-in xDS resolver, or Istio/Envoy-integrated clients) |

xDS is the production answer at scale — it gives client-side load balancing (no extra proxy hop, no L4-connection-pinning problem) while still getting centrally-managed, dynamically-updated backend membership the way a proxy-based LB would.

<div class="quiz-card">
  <p class="quiz-q">A team puts a plain TCP network load balancer in front of a 3-pod gRPC deployment, the same way they would for a REST service. Traffic is wildly uneven across pods. Why doesn't the L4 LB fix this the way it would for HTTP/1.1?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>An L4 LB balances connections, not individual requests. HTTP/1.1 clients typically open many short-lived connections, so connection-level balancing happens to spread load evenly. gRPC deliberately reuses one long-lived HTTP/2 connection for many multiplexed RPCs — the L4 LB only makes its balancing decision once, when that connection is established, and every RPC multiplexed on top of it goes to whichever backend got picked at that moment. Fixing this needs client-side round_robin, a gRPC-aware L7 proxy, or xDS — not a smarter L4 LB.</div>
</div>

---

## 8. gRPC-Web

Browsers cannot originate raw gRPC calls: no browser JS API can set HTTP/2 trailers, control frame-level flow control, or send arbitrary binary frames outside of `fetch`/`XHR`'s constraints — and browsers don't expose trailer read access at all, which gRPC's status reporting depends on.

```mermaid
flowchart LR
    classDef blue fill:#3498db,stroke:#2980b9,color:#fff,rx:8
    classDef orange fill:#e67e22,stroke:#d35400,color:#fff,rx:8
    classDef purple fill:#9b59b6,stroke:#8e44ad,color:#fff,rx:8

    subgraph BROWSERSIDE["Browser — can't speak real gRPC"]
        BROWSER["Browser<br>grpc-web client lib<br>no HTTP/2 trailer access at all"]:::blue
    end

    subgraph PROXYTIER["Translating proxy"]
        PROXY["Envoy grpc_web filter<br>(or dedicated grpcwebproxy)<br>reframes trailers into the body stream"]:::purple
    end

    subgraph BACKENDSIDE["Backend — unaware anything was translated"]
        BACKEND["gRPC backend service<br>speaks real gRPC the whole time"]:::orange
    end

    BROWSER -->|"HTTP/1.1 or HTTP/2<br>base64 or binary,<br>no trailers needed"| PROXY
    PROXY -->|"real gRPC<br>HTTP/2 + trailers"| BACKEND
    BACKEND -->|"real gRPC response<br>+ trailers (grpc-status)"| PROXY
    PROXY -->|"trailers repacked into<br>a trailer frame in the body"| BROWSER
```

The `grpc-web` wire format moves trailers (`grpc-status`, `grpc-message`) into the message body stream itself (as a special trailer frame appended after the last data frame) instead of relying on HTTP/2 trailers — something a browser fetch response body can actually deliver. A translating proxy (Envoy's `grpc_web` filter, or a dedicated `grpcwebproxy`) converts between this browser-safe framing and real gRPC on the backend side.

```mermaid
sequenceDiagram
    participant B as Browser (grpc-web client)
    participant P as Envoy grpc_web filter
    participant S as gRPC backend

    B->>P: HTTP request (base64 or binary body,<br>no trailers, fetch/XHR-compatible)
    P->>S: Real gRPC call over HTTP/2<br>(HEADERS + DATA)
    Note over S: Backend has no idea this call<br>originated from a browser
    S-->>P: DATA (response message)
    S-->>P: HEADERS, END_STREAM=true (trailers: grpc-status, grpc-message)
    Note over P: Proxy can't hand the browser real HTTP/2 trailers —<br>it repacks grpc-status/grpc-message as a trailer frame<br>appended to the end of the body itself
    P-->>B: Response body: [message frame][trailer frame with grpc-status]
    Note over B: grpc-web client library parses the trailer frame<br>out of the body it can actually read
```

```yaml
# Envoy grpc-web filter snippet
http_filters:
  - name: envoy.filters.http.grpc_web
  - name: envoy.filters.http.cors
  - name: envoy.filters.http.router
```

```typescript
// Browser client using grpc-web generated stubs
import { OrderServiceClient } from "./order_v1_grpc_web_pb";
const client = new OrderServiceClient("https://api.example.com"); // hits the Envoy proxy, not the backend directly

client.getOrder(request, {}, (err, response) => {
  if (err) { console.error(err.code, err.message); return; }
  console.log(response.toObject());
});
```

Note: gRPC-Web does not support client-streaming or bidirectional streaming in browsers (no way to half-close a request stream over `fetch`) — only unary and server-streaming work end-to-end.

<div class="quiz-card">
  <p class="quiz-q">Why can't a browser just call a gRPC backend directly instead of going through a translating proxy?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No browser JS API can set HTTP/2 trailers, control frame-level flow control, or send arbitrary binary frames beyond what fetch/XHR allow — and critically, browsers don't expose trailer *read* access at all, which is exactly what gRPC's grpc-status reporting depends on. The grpc-web wire format works around this by moving grpc-status/grpc-message into a special trailer frame inside the body stream itself, which a browser response body actually can deliver — but something still has to translate that into real HTTP/2 trailers for the backend, which is the proxy's whole job.</div>
</div>

---

## 9. Error Handling

### Status code mapping vs HTTP

| gRPC code | Numeric | Closest HTTP equivalent | Meaning |
|---|---|---|---|
| OK | 0 | 200 | Success |
| CANCELLED | 1 | 499 (nginx convention) | Client cancelled the call |
| UNKNOWN | 2 | 500 | Unhandled server exception |
| INVALID_ARGUMENT | 3 | 400 | Malformed request |
| DEADLINE_EXCEEDED | 4 | 504 | Timed out |
| NOT_FOUND | 5 | 404 | Resource missing |
| ALREADY_EXISTS | 6 | 409 | Conflict |
| PERMISSION_DENIED | 7 | 403 | Authenticated, not authorized |
| RESOURCE_EXHAUSTED | 8 | 429 | Rate limited / quota exceeded |
| FAILED_PRECONDITION | 9 | 400/409 | System not in a state the request requires |
| ABORTED | 10 | 409 | Concurrency conflict (e.g. optimistic lock failure) |
| OUT_OF_RANGE | 11 | 400 | Value outside valid range |
| UNIMPLEMENTED | 12 | 501 | Method not implemented by server |
| INTERNAL | 13 | 500 | Server-side invariant violation |
| UNAVAILABLE | 14 | 503 | Server down — safe to retry |
| DATA_LOSS | 15 | 500 | Unrecoverable data loss/corruption |
| UNAUTHENTICATED | 16 | 401 | No/invalid credentials |

The same 16 codes grouped by what they actually tell a caller to do — useful for deciding retry logic, since "is this safe to retry" cuts across the table above in a way the numeric ordering doesn't show:

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="success" class="active state-ok">Success</button>
    <button data-toggle-opt="retryable" class="state-warn">Retryable / transient</button>
    <button data-toggle-opt="clienterror" class="state-warn">Client-caused</button>
    <button data-toggle-opt="servererror" class="state-bad">Server-caused</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="success">
    <strong>OK (0).</strong> The only success code. Everything else in this table is some flavor of failure.
  </div>
  <div class="toggle-panel" data-toggle-panel="retryable">
    <strong>UNAVAILABLE (14), DEADLINE_EXCEEDED (4), ABORTED (10).</strong> The server was down (safe to retry), the call timed out (retry with a fresh deadline may succeed), or a concurrency conflict happened (an optimistic-lock-style retry can resolve it). These are the codes a generic retry policy should act on — the other categories generally shouldn't be blindly retried.
  </div>
  <div class="toggle-panel" data-toggle-panel="clienterror">
    <strong>INVALID_ARGUMENT (3), NOT_FOUND (5), ALREADY_EXISTS (6), PERMISSION_DENIED (7), FAILED_PRECONDITION (9), OUT_OF_RANGE (11), UNAUTHENTICATED (16), RESOURCE_EXHAUSTED (8), CANCELLED (1).</strong> The caller sent a malformed, unauthorized, or rate-limited request, or cancelled it themselves. Retrying the exact same request without changing anything will fail the same way again (except RESOURCE_EXHAUSTED, which can succeed later once quota frees up).
  </div>
  <div class="toggle-panel" data-toggle-panel="servererror">
    <strong>UNKNOWN (2), UNIMPLEMENTED (12), INTERNAL (13), DATA_LOSS (15).</strong> Something went wrong on the server side that the client can't fix by changing its request — an unhandled exception, a method that doesn't exist, a broken invariant, or corrupted data. Worth alerting on; not worth blindly retrying.
  </div>
</div>

<div class="quiz-card">
  <p class="quiz-q">A client gets FAILED_PRECONDITION on a request. Is it safe for a generic retry policy to immediately retry the exact same request?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>No. FAILED_PRECONDITION means the system isn't in a state the request requires — that's a client-caused condition, not a transient server problem. Retrying the identical request hits the same precondition failure again; only UNAVAILABLE, DEADLINE_EXCEEDED, and ABORTED are the codes a blind retry policy should act on, and even those only make sense with backoff, not an immediate resend.</div>
</div>

### Rich error details via `google.rpc.Status`

A bare gRPC status code + string message is often not enough — `google.rpc.Status` lets you attach structured, typed detail messages (field violations, retry hints, quota info) that clients can programmatically parse instead of string-matching error messages.

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server (CreateOrder handler)

    C->>S: CreateOrder({amount: -5})
    Note over S: Validation fails — amount must be > 0
    S->>S: status.New(codes.InvalidArgument, "invalid order")
    S->>S: attach typed detail: errdetails.BadRequest{FieldViolations: [{Field: "amount", ...}]}
    S-->>C: gRPC error: status=INVALID_ARGUMENT<br>+ serialized google.rpc.Status with BadRequest detail

    Note over C: Client doesn't string-match the message
    C->>C: st := status.Convert(err)
    C->>C: type-assert st.Details() back to *errdetails.BadRequest
    C->>C: read FieldViolations programmatically —<br>field="amount", description="must be greater than zero"
```

```protobuf
import "google/rpc/error_details.proto";

// Server constructs a status with typed details:
```

```go
import (
    "google.golang.org/genproto/googleapis/rpc/errdetails"
    "google.golang.org/grpc/status"
    "google.golang.org/grpc/codes"
)

func (s *server) CreateOrder(ctx context.Context, req *CreateOrderRequest) (*Order, error) {
    if req.Amount <= 0 {
        st := status.New(codes.InvalidArgument, "invalid order")
        detail := &errdetails.BadRequest{
            FieldViolations: []*errdetails.BadRequest_FieldViolation{
                {Field: "amount", Description: "must be greater than zero"},
            },
        }
        stWithDetails, err := st.WithDetails(detail)
        if err != nil {
            return nil, st.Err() // fall back to plain status if attaching details fails
        }
        return nil, stWithDetails.Err()
    }
    // ...
}
```

```go
// Client extracts structured details instead of parsing message strings
resp, err := client.CreateOrder(ctx, req)
if err != nil {
    st := status.Convert(err)
    for _, detail := range st.Details() {
        if br, ok := detail.(*errdetails.BadRequest); ok {
            for _, v := range br.FieldViolations {
                log.Printf("field=%s issue=%s", v.Field, v.Description)
            }
        }
    }
}
```

Other common `google.rpc` detail types: `RetryInfo` (how long to back off), `QuotaFailure` (which quota was exceeded), `DebugInfo` (stack trace, internal-only), `PreconditionFailure`, `ResourceInfo`. Prefer these over encoding structured data into the plain `message` string — they survive serialization across languages consistently since they're just protobuf messages.

<div class="quiz-card">
  <p class="quiz-q">Why does attaching a typed errdetails.BadRequest detail beat putting "field 'amount' must be greater than zero" directly into the status message string?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>Because the client can extract it programmatically — type-asserting st.Details() back to *errdetails.BadRequest and reading FieldViolations — instead of string-matching or regex-parsing a human-readable sentence that could change wording at any time. google.rpc detail types are themselves protobuf messages, so they serialize and deserialize consistently across every language a gRPC client might be written in, unlike a free-text message meant for a human to read.</div>
</div>
