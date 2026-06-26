# HTTP — Client-Server Communication, Versions, Methods, Headers

## HTTP Client-Server: What Actually Happens

```mermaid
sequenceDiagram
    participant BROWSER as Browser / Client
    participant DNS2 as DNS
    participant SERVER as HTTP Server

    Note over BROWSER,SERVER: Step 1 — DNS (if first visit)
    BROWSER->>DNS2: resolve api.example.com
    DNS2-->>BROWSER: 93.184.216.34

    Note over BROWSER,SERVER: Step 2 — TCP Connection
    BROWSER->>SERVER: TCP SYN (port 80 for HTTP)
    SERVER-->>BROWSER: TCP SYN-ACK
    BROWSER-->>SERVER: TCP ACK
    Note over BROWSER,SERVER: TCP connection established

    Note over BROWSER,SERVER: Step 3 — HTTP Request
    BROWSER->>SERVER: GET /users/123 HTTP/1.1
    Note over BROWSER: Headers sent:<br>Host: api.example.com<br>Accept: application/json<br>Connection: keep-alive

    Note over BROWSER,SERVER: Step 4 — Server processes request
    SERVER->>SERVER: parse URL, route to handler
    SERVER->>SERVER: query DB, build response
    SERVER-->>BROWSER: HTTP/1.1 200 OK
    Note over SERVER: Headers sent:<br>Content-Type: application/json<br>Content-Length: 145<br>Cache-Control: max-age=60

    Note over BROWSER,SERVER: Step 5 — Body
    SERVER-->>BROWSER: {"id":123,"name":"Alice"}

    Note over BROWSER,SERVER: Connection kept alive (keep-alive) for next request
```

## HTTPS: Adding TLS Between TCP and HTTP

Plain HTTP sends everything as readable text — anyone on the network can read your passwords, cookies, and data. HTTPS wraps HTTP inside a TLS tunnel so all data is encrypted.

```mermaid
graph LR
    subgraph HTTP["HTTP (Port 80) — INSECURE"]
        A1["Browser"] -->|"GET /login\npassword=alice123\n← VISIBLE to anyone on network"| B1["Server"]
    end

    subgraph HTTPS["HTTPS (Port 443) — SECURE"]
        A2["Browser"] -->|"Xk39dP#!@Nm2...\n← looks like garbage to attackers"| B2["Server"]
        B2 -->|"decrypts with private key<br>reads: password=alice123"| B2
    end
```

**What HTTPS adds on top of HTTP:**

```mermaid
sequenceDiagram
    participant C as Client (Browser)
    participant S as HTTPS Server (google.com)

    rect rgb(200, 230, 255)
        Note over C,S: ① TCP Handshake — same as HTTP (1 round trip)
        C->>S: SYN → port 443
        S-->>C: SYN-ACK
        C-->>S: ACK ✓ TCP connected
    end

    rect rgb(200, 255, 200)
        Note over C,S: ② TLS Handshake — NEW, not in plain HTTP (1-2 round trips)
        C->>S: "I support TLS 1.3, here are my cipher preferences<br>My ECDHE public key: [key_share]"
        S-->>C: "Let's use TLS_AES_256_GCM_SHA384<br>My ECDHE public key: [key_share]<br>📜 Certificate: CN=*.google.com<br>🔏 Signed by: DigiCert (trusted CA)"
        Note over C: ✓ Certificate valid?<br>✓ Domain matches google.com?<br>✓ Not expired?<br>✓ DigiCert in my trusted CAs?
        C->>S: ✓ Finished (keys derived, handshake verified)
        Note over C,S: 🔑 Both derived the SAME session key<br>Nobody intercepting the network has this key
    end

    rect rgb(255, 230, 200)
        Note over C,S: ③ HTTP over TLS — everything encrypted
        C->>S: [ENCRYPTED] GET /gmail HTTP/2<br>Cookie: session=abc123<br>Authorization: Bearer token...
        S-->>C: [ENCRYPTED] 200 OK<br>Your emails here...
        Note over C,S: Attacker sees random bytes — cannot read anything
    end
```

**The role of public and private keys:**

```mermaid
graph TD
    CERT["📜 Certificate contains:<br>Server's PUBLIC KEY 🔓<br>Domain: *.google.com<br>Signed by: DigiCert"]

    BROWSER["Browser has DigiCert's public key<br>(pre-installed in OS/browser)"] -->|"verify DigiCert's signature<br>on the certificate"| CERT

    CERT -->|"browser uses server's PUBLIC KEY 🔓<br>to help establish shared session key"| SESSION["🔑 Session key (AES)<br>derived by both sides<br>used for all data"]

    PRIV["Server's PRIVATE KEY 🔒<br>never leaves the server"] -->|"server uses private key<br>to complete key exchange"| SESSION
```



```mermaid
sequenceDiagram
    participant C2 as Client
    participant S2 as Server

    rect rgb(255, 240, 240)
        Note over C2,S2: TLS 1.2 — 2 Round Trips before data
        C2->>S2: ClientHello (cipher suites, client_random)
        S2->>C2: ServerHello + Certificate + ServerKeyExchange + Done
        Note over C2: Verify cert. Generate pre-master. Derive keys.
        C2->>S2: ClientKeyExchange (pre-master encrypted with server pub key)<br>ChangeCipherSpec + Finished
        S2->>C2: ChangeCipherSpec + Finished
        Note over C2,S2: 2 RTTs done — NOW send HTTP
        C2->>S2: GET / HTTP/1.1 [encrypted]
    end

    rect rgb(240, 255, 240)
        Note over C2,S2: TLS 1.3 — 1 Round Trip before data
        C2->>S2: ClientHello + key_share (ECDHE public key)
        Note over S2: Server derives keys immediately from client key_share
        S2->>C2: ServerHello + key_share + Certificate (encrypted!) + Finished
        Note over C2: Derive same keys. Verify cert.
        C2->>S2: Finished + GET / HTTP/1.1 [encrypted, sent in same flight!]
    end
```

**Why TLS 1.3 is faster:**
- TLS 1.2: client must wait for server cert before deriving keys → 2 RTTs
- TLS 1.3: client sends its ECDHE key_share upfront → server derives keys in first message → **1 RTT**
- TLS 1.3 also encrypts the certificate (TLS 1.2 cert is plaintext on the wire)



```mermaid
graph LR
    H10["HTTP/1.0 (1996)<br>One request per TCP connection<br>Close after each response<br>High latency — new TCP+TLS per request"]
    H11["HTTP/1.1 (1997)<br>Keep-Alive connections<br>Pipelining (rarely used)<br>Head-of-line blocking<br>6 parallel connections per host (browser limit)"]
    H2["HTTP/2 (2015)<br>Binary framing<br>Multiplexing: many streams on ONE TCP<br>Header compression (HPACK)<br>Server push<br>Still has TCP HOL blocking"]
    H3["HTTP/3 (2022)<br>QUIC over UDP<br>No TCP HOL blocking<br>0-RTT connection resume<br>Connection migration (change IP, keep session)"]

    H10 --> H11 --> H2 --> H3
```

### Head-of-Line Blocking

```mermaid
graph TD
    subgraph H11["HTTP/1.1: 6 TCP connections (browser limit)"]
        C1["Conn 1: GET /index.html done"]
        C2["Conn 2: GET /style.css done"]
        C3["Conn 3: GET /app.js SLOW (100ms)"]
        C4["Conn 4: blocked waiting for Conn 3 slot"]
        C5["Conn 5: GET /image.png"]
        C6["Conn 6: waiting..."]
    end

    subgraph H2["HTTP/2: 1 TCP, many streams"]
        MUX["Single TCP connection<br>multiplexed streams"]
        S1["Stream 1: /index.html"]
        S2["Stream 2: /style.css"]
        S3["Stream 3: /app.js (slow)"]
        S4["Stream 4: /image.png"]
        S5["Stream 5: /font.woff"]
        MUX --> S1 & S2 & S3 & S4 & S5
        NOTE["S3 slow? Other streams unaffected<br>(TCP HOL only if packet loss)"]
    end
```

**HTTP/2 stream priority:** Each stream has a weight (1-256) and optional dependency. The server can prioritize CSS/JS over images. In practice, most servers use equal priority.

### HTTP/2 Binary Framing

```
HTTP/1.1 (text):                    HTTP/2 (binary frames):
GET /users HTTP/1.1                 HEADERS frame {
Host: api.example.com                 :method: GET
Accept: application/json              :path: /users
                                      :authority: api.example.com
                                      accept: application/json
                                    }
                                    DATA frame { body bytes }
```

Each HTTP/2 frame has:
- **Length** (3 bytes)
- **Type** (1 byte): HEADERS, DATA, SETTINGS, WINDOW_UPDATE, PING, GOAWAY
- **Flags** (1 byte): END_STREAM, END_HEADERS, PADDED, PRIORITY
- **Stream ID** (4 bytes): which request this belongs to (odd=client, even=server)

---

## TLS 1.2 vs TLS 1.3 — Visual Comparison

The core improvement in TLS 1.3: client sends its ECDHE key upfront, so the server derives encryption keys in the **first message** — saving one full round trip.

```mermaid
sequenceDiagram
    participant C2 as Browser
    participant S2 as Server

    rect rgb(255, 235, 235)
        Note over C2,S2: TLS 1.2 — needs 2 round trips before HTTP data
        C2->>S2: ClientHello — supported cipher suites
        S2->>C2: ServerHello + Certificate + Key params
        Note over C2: Wait for cert... verify... generate secret
        C2->>S2: Encrypted pre-master secret + ChangeCipherSpec
        S2->>C2: ChangeCipherSpec + Finished
        Note over C2,S2: 2 round trips spent — only NOW can HTTP start
        C2->>S2: GET /page [ENCRYPTED]
    end

    rect rgb(235, 255, 235)
        Note over C2,S2: TLS 1.3 — only 1 round trip before HTTP data
        C2->>S2: ClientHello + ECDHE key_share
        Note over S2: Server derives session keys immediately
        S2->>C2: ServerHello + ECDHE key_share + Certificate + Finished
        Note over C2: Derives same keys. Verify cert.
        C2->>S2: Finished + GET /page [ENCRYPTED in same message]
        Note over C2,S2: 1 round trip done — HTTP data sent with Finished
    end
```

**Real-world impact at 50ms RTT:**
- TLS 1.2: 2 × 50ms = 100ms before first byte of response
- TLS 1.3: 1 × 50ms = 50ms before first byte of response
- TLS 1.3 0-RTT resumption: 0ms if reconnecting to same server within session window

---

## HTTP Request / Response Structure

```
Request:
GET /api/users?page=2 HTTP/2
Host: api.example.com
Authorization: Bearer eyJhbGc...
Accept: application/json
Content-Type: application/json
X-Request-ID: abc-123

{"filter": "active"}


Response:
HTTP/2 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: max-age=60, public
X-RateLimit-Remaining: 99
X-RateLimit-Reset: 1700000300

{"users": [...], "total": 150}
```

---

## HTTP Status Codes

```mermaid
graph LR
    S1["1xx Informational<br>100 Continue<br>101 Switching Protocols (WebSocket upgrade)"]
    S2["2xx Success<br>200 OK<br>201 Created<br>204 No Content<br>206 Partial Content (range requests)"]
    S3["3xx Redirect<br>301 Moved Permanently (cache)<br>302 Found (temp, no cache)<br>304 Not Modified (ETag matched)<br>307 Temporary Redirect (keep method)"]
    S4["4xx Client Error<br>400 Bad Request<br>401 Unauthorized (not authenticated)<br>403 Forbidden (authenticated, no permission)<br>404 Not Found<br>409 Conflict<br>422 Unprocessable Entity<br>429 Too Many Requests"]
    S5["5xx Server Error<br>500 Internal Server Error<br>502 Bad Gateway (upstream error)<br>503 Service Unavailable<br>504 Gateway Timeout"]
```

**401 vs 403:** 401 = you didn't authenticate (no token or invalid token). 403 = you authenticated but don't have permission.

**502 vs 503 vs 504:**
- 502: ALB/nginx got an invalid response from the upstream (app crashed, wrong protocol)
- 503: Service is down or overloaded (upstream refused connection)
- 504: Upstream timed out (app is alive but too slow)

---

## HTTP Methods

| Method | Idempotent | Safe | Body | Typical use |
|--------|-----------|------|------|-------------|
| GET | Yes | Yes | No | Read resource |
| POST | No | No | Yes | Create / trigger action |
| PUT | Yes | No | Yes | Full replace (create or overwrite) |
| PATCH | No | No | Yes | Partial update |
| DELETE | Yes | No | No | Delete resource |
| HEAD | Yes | Yes | No | Get headers only (check if modified) |
| OPTIONS | Yes | Yes | No | CORS preflight, list allowed methods |

**Idempotent** = calling it N times has same effect as calling it once. DELETE is idempotent (deleting already-deleted resource returns 404, not an error state). POST is not — calling POST twice creates two resources.

---

## Important HTTP Headers

### Request headers
```
Host: api.example.com              # required in HTTP/1.1+, which virtual host
Authorization: Bearer <token>      # auth credentials
Content-Type: application/json     # body format
Accept: application/json           # what formats client accepts
Accept-Encoding: gzip, br          # compression algorithms client supports
User-Agent: Mozilla/5.0...         # client identification
X-Request-ID: uuid                 # for distributed tracing
Cookie: session=abc123             # client sends stored cookies
```

### Response headers
```
Content-Type: application/json     # body format
Content-Encoding: gzip             # body is compressed
Cache-Control: max-age=3600, public # cache for 1 hour
ETag: "abc123"                     # content hash for conditional requests
Last-Modified: Wed, 21 Oct 2024    # when resource last changed
Set-Cookie: session=abc; Secure; HttpOnly; SameSite=Strict
X-RateLimit-Limit: 100             # rate limit max
X-RateLimit-Remaining: 87          # requests left
Strict-Transport-Security: max-age=31536000; includeSubDomains  # HSTS
Access-Control-Allow-Origin: *     # CORS
```

### Caching with ETag

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    C->>S: GET /api/users
    S->>C: 200 OK + ETag: "v42" + body

    Note over C: Later, check if stale
    C->>S: GET /api/users<br>If-None-Match: "v42"
    S->>C: 304 Not Modified (no body — save bandwidth)
    Note over C: Use cached response
```

---

## CORS — Cross-Origin Resource Sharing

```mermaid
sequenceDiagram
    participant BROWSER as Browser (app.example.com)
    participant API as API (api.other.com)

    Note over BROWSER,API: Preflight for non-simple requests (POST+JSON)
    BROWSER->>API: OPTIONS /api/data<br>Origin: https://app.example.com<br>Access-Control-Request-Method: POST<br>Access-Control-Request-Headers: Authorization

    API->>BROWSER: 200 OK<br>Access-Control-Allow-Origin: https://app.example.com<br>Access-Control-Allow-Methods: GET, POST, PUT<br>Access-Control-Allow-Headers: Authorization<br>Access-Control-Max-Age: 86400

    Note over BROWSER,API: Actual request
    BROWSER->>API: POST /api/data<br>Origin: https://app.example.com
    API->>BROWSER: 200 OK + Access-Control-Allow-Origin
```

**Simple requests** (no preflight): GET/HEAD/POST with `Content-Type: text/plain` or `application/x-www-form-urlencoded` or `multipart/form-data`.

**Non-simple** (needs preflight): Any request with `Authorization` header, `Content-Type: application/json`, or methods like PUT/DELETE/PATCH.
