# TLS, SSL, and Encryption

## Encryption — The Big Picture (Generic)

Before TLS specifics, understand the three types of encryption and why HTTPS needs all three.

### 1. Symmetric Encryption — One Shared Key

Both sides use the **same key** to lock and unlock.

```mermaid
graph LR
    PLAIN1["Hello World\n(plaintext)"]
    KEY1["🔑 Key: ABC123"]
    ENC1["Xk39dP#!\n(ciphertext)"]
    DEC1["Hello World\n(plaintext)"]

    PLAIN1 -->|"encrypt with KEY1"| ENC1
    ENC1 -->|"decrypt with KEY1"| DEC1
    KEY1 -.->|"same key used both ways"| ENC1
```

**Problem:** How do you share the key? If an attacker intercepts it, they can decrypt everything.

**Fast:** AES-256-GCM encrypts ~1 GB/s. Used for all bulk data.

### 2. Asymmetric Encryption — Public/Private Key Pair

Two mathematically linked keys. **Public key encrypts, private key decrypts.** The private key never leaves the server.

```mermaid
graph TD
    SERVER["Server generates key pair once:<br>🔓 Public key  (share with everyone)<br>🔒 Private key (NEVER share, stays on server)"]

    subgraph "Anyone can send a secret message"
        ALICE["Alice has a secret: 'my password'"]
        ALICE -->|"encrypt with server's PUBLIC key 🔓"| CIPHER["Xk39dP#!\n(ciphertext)"]
        CIPHER -->|"send over internet"| SERVER2["Server decrypts with PRIVATE key 🔒"]
        SERVER2 --> PLAIN2["'my password'\n(recovered)"]
    end

    subgraph "Attacker intercepts but cannot decrypt"
        ATTACKER["Eve intercepts: Xk39dP#!"]
        ATTACKER -->|"has public key 🔓\nbut NOT private key 🔒"| FAIL["❌ Cannot decrypt"]
    end
```

**Problem:** 100× slower than symmetric. Can't use for bulk data.

### 3. How HTTPS Combines Both (Hybrid Encryption)

HTTPS uses asymmetric only to **agree on a shared key**, then uses symmetric for all data:

```mermaid
sequenceDiagram
    participant C as Your Browser
    participant S as Server (e.g. google.com)

    Note over C,S: Step 1 — Key Exchange (Asymmetric, happens once)
    S->>C: "Here's my PUBLIC KEY 🔓 (inside the certificate)"
    C->>C: Generate a random session key: 🔑 "7f3a9c..."
    C->>S: Encrypt session key with server's PUBLIC KEY 🔓<br>→ send "Xk8dP#!" (only server can decrypt)
    S->>S: Decrypt with PRIVATE KEY 🔒<br>→ recovers session key 🔑 "7f3a9c..."

    Note over C,S: Both now have the same session key 🔑 — nobody else does

    Note over C,S: Step 2 — Actual Data (Symmetric, blazing fast)
    C->>S: "GET /profile" encrypted with 🔑 session key
    S->>C: "200 OK {name: Alice}" encrypted with 🔑 session key

    Note over C,S: If attacker intercepts step 1 — only sees encrypted session key<br>Cannot decrypt without private key 🔒
```

**Summary of what each does in HTTPS:**

| Crypto type | Used for | Why |
|-------------|---------|-----|
| Asymmetric (RSA/ECDH) | Key exchange only | Solves the key-sharing problem |
| Symmetric (AES-256-GCM) | All actual data | Fast enough for gigabytes |
| Hashing (SHA-256) | Certificate signatures, MAC | Verify nothing was tampered with |

---

## Symmetric vs Asymmetric — Side by Side

```mermaid
graph TD
    subgraph SYM["Symmetric Encryption"]
        SA["🔑 One key<br>Same key encrypts AND decrypts<br>AES-256-GCM, ChaCha20<br>Speed: ~1 GB/s<br>Problem: how to share the key?"]
    end

    subgraph ASYM["Asymmetric Encryption"]
        AS["🔓🔒 Key pair<br>PUBLIC key encrypts<br>PRIVATE key decrypts<br>RSA-2048, ECDSA, ECDH<br>Speed: ~10 MB/s<br>No key-sharing problem"]
    end

    subgraph HYBRID["Hybrid (what TLS does)"]
        HY["Use ASYM to exchange a symmetric key securely<br>Then use SYM for all data<br>Best of both: security + speed"]
    end

    SYM -->|"solves speed"| HYBRID
    ASYM -->|"solves key exchange"| HYBRID
```

---



```mermaid
graph TD
    subgraph SYM["Symmetric — one key"]
        A1["AES-256-GCM<br>Same key encrypts and decrypts<br>Fast: ~1 GB/s on modern CPU<br>Problem: how to share the key securely?"]
    end
    subgraph ASYM["Asymmetric — key pair"]
        A2["RSA-2048 / ECDSA / ECDH<br>Public key encrypts, private key decrypts<br>Slow: ~10 MB/s<br>No key-sharing problem — public key is public"]
    end
    subgraph HYBRID["TLS uses HYBRID"]
        H1["ECDHE (asymmetric)<br>Securely agree on a shared secret"]
        H2["AES-256-GCM (symmetric)<br>Encrypt all actual data with that secret"]
        H1 --> H2
    end
```

**Why hybrid?** Asymmetric crypto solves the key exchange problem but is 100× slower than AES. TLS uses asymmetric only to agree on a shared session key, then switches to AES for all data.

**Forward Secrecy (ECDHE):** Each session generates a new ephemeral key pair. The server's long-term private key is never used to encrypt data — only to authenticate. If the private key is stolen years later, past sessions cannot be decrypted.

---

## SSL vs TLS History

```mermaid
graph LR
    SSL2["SSL 2.0 (1995)<br>BROKEN — DROWN attack<br>Deprecated 1996"] --> SSL3
    SSL3["SSL 3.0 (1996)<br>BROKEN — POODLE attack<br>Deprecated 2015"] --> TLS10
    TLS10["TLS 1.0 (1999)<br>BEAST, POODLE variants<br>Deprecated 2021"] --> TLS11
    TLS11["TLS 1.1 (2006)<br>Deprecated 2021"] --> TLS12
    TLS12["TLS 1.2 (2008)<br>Current — widely deployed<br>2 RTT handshake"] --> TLS13
    TLS13["TLS 1.3 (2018)<br>CURRENT PREFERRED<br>1 RTT, forward secrecy mandatory"]
```

**Minimum acceptable today:** TLS 1.2. Prefer TLS 1.3.

---

## TLS 1.2 Handshake (2 RTT)

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: Round Trip 1
    C->>S: ClientHello<br>TLS version: 1.2<br>Random: 32 bytes<br>Cipher suites: [TLS_ECDHE_RSA_AES256_GCM_SHA384, ...]<br>Extensions: SNI=google.com, ALPN=h2

    S->>C: ServerHello<br>Chosen cipher: TLS_ECDHE_RSA_AES256_GCM_SHA384<br>Random: 32 bytes
    S->>C: Certificate<br>*.google.com cert + intermediate CA chain
    S->>C: ServerKeyExchange<br>ECDHE public key (ephemeral)<br>Signed with server private key
    S->>C: ServerHelloDone

    Note over C,S: Round Trip 2
    C->>C: Verify cert chain against OS root store
    C->>C: Generate pre-master secret from ECDHE keys
    C->>C: Derive session keys (AES key + MAC key)
    C->>S: ClientKeyExchange (ECDHE public key)
    C->>S: ChangeCipherSpec (switch to encryption)
    C->>S: Finished (HMAC of all handshake messages)

    S->>S: Derive same session keys
    S->>C: ChangeCipherSpec
    S->>C: Finished

    Note over C,S: Encrypted data flows — 2 RTTs spent
    C->>S: HTTP GET / (encrypted with AES-256-GCM)
```

---

## TLS 1.3 Handshake (1 RTT)

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server

    Note over C,S: Single Round Trip
    C->>S: ClientHello<br>TLS 1.3<br>key_share: ECDHE public key (X25519)<br>supported_groups: X25519, P-256<br>SNI: google.com<br>ALPN: h2

    Note over S: Server derives keys NOW from client's key_share
    S->>C: ServerHello + key_share (server ECDHE public key)
    S->>C: EncryptedExtensions (ALPN negotiated)
    S->>C: Certificate (now ENCRYPTED — leaks no metadata)
    S->>C: CertificateVerify (signature over handshake transcript)
    S->>C: Finished (HMAC of transcript)

    Note over C: Client derives same keys, verifies cert, sends Finished
    C->>S: Finished
    C->>S: HTTP GET / (already encrypted — sent with Finished!)

    Note over C,S: 1 RTT total

    Note over C,S: 0-RTT Resumption (optional, replay risk)
    C->>S: ClientHello + early_data (HTTP GET immediately)
    Note over S: No handshake needed — use pre-shared session ticket
    S->>C: HTTP Response
```

**TLS 1.3 vs TLS 1.2:**

| Feature | TLS 1.2 | TLS 1.3 |
|---------|---------|---------|
| Handshake RTTs | 2 | 1 (0 with resumption) |
| Forward secrecy | Optional (RSA key exchange exists) | Mandatory (ECDHE only) |
| Certificate visibility | Plaintext to network | Encrypted |
| Weak ciphers | RC4, 3DES, MD5 allowed | All removed |
| Session resumption | Session ID or ticket | PSK (pre-shared key) |
| Key exchange | RSA or ECDHE | ECDHE only (X25519, P-256) |

---

## TLS Certificate Chain

```mermaid
graph TD
    ROOT["Root CA Certificate<br>DigiCert Global Root G2<br>Self-signed<br>Pre-installed in OS/browsers<br>Private key stored OFFLINE (air-gapped HSM)"]
    INTER["Intermediate CA Certificate<br>DigiCert TLS RSA SHA256 2020 CA1<br>Signed by Root CA<br>Used for day-to-day signing"]
    LEAF["Leaf Certificate<br>*.google.com<br>Public key for TLS<br>SANs: google.com, www.google.com<br>Valid: 2024-01-01 to 2025-01-01<br>Signed by Intermediate CA"]

    ROOT -->|"signs"| INTER
    INTER -->|"signs"| LEAF
    LEAF -->|"presented during TLS handshake"| SERVER["google.com"]
```

**Certificate fields:**
```
Subject:    CN=*.google.com
Issuer:     CN=DigiCert TLS RSA SHA256 2020 CA1
SANs:       DNS:*.google.com, DNS:google.com
Not Before: 2024-01-15 00:00:00 UTC
Not After:  2025-02-14 23:59:59 UTC
Public Key: EC 256-bit (P-256)
Signature:  SHA256WithRSA
```

**Why 3 levels?** Root CA private keys are air-gapped — never online. Intermediate CA does daily signing. If an intermediate is compromised, revoke it without touching the root. The root change would require every OS/browser to update their trust store.

### Certificate Validation Steps

```mermaid
flowchart TD
    RECV["Client receives certificate"] --> SIG
    SIG["Verify signature chain<br>Intermediate signed Leaf?<br>Root signed Intermediate?"] --> TRUST
    TRUST["Root CA in OS trust store?<br>/etc/ssl/certs/ or system keychain"] --> EXPIRY
    EXPIRY["Not Before <= now <= Not After?"] --> SAN
    SAN["SAN matches requested hostname?<br>*.google.com matches google.com?"] --> REVOKE
    REVOKE["Not revoked?<br>CRL or OCSP check"] --> OK["Certificate VALID<br>proceed with handshake"]
    SIG & TRUST & EXPIRY & SAN & REVOKE -->|"any fail"| ERR["TLS handshake FAILED<br>connection aborted"]
```

---

## Debugging TLS

```bash
# Full TLS handshake inspection
openssl s_client -connect google.com:443 -servername google.com
# Shows: cipher, cert chain, handshake details

# Check TLS version and cipher
openssl s_client -connect google.com:443 -tls1_3 2>/dev/null | grep "Protocol\|Cipher"

# Certificate expiry check
openssl s_client -connect google.com:443 2>/dev/null | openssl x509 -noout -dates

# Check all SANs on a certificate
openssl s_client -connect google.com:443 2>/dev/null | openssl x509 -noout -text | grep -A2 "Subject Alternative"

# Test specific TLS version (should fail for 1.0/1.1 on modern servers)
openssl s_client -connect google.com:443 -tls1   # TLS 1.0 — should fail
openssl s_client -connect google.com:443 -tls1_2 # TLS 1.2 — should work
openssl s_client -connect google.com:443 -tls1_3 # TLS 1.3 — should work

# curl with verbose TLS info
curl -v --tlsv1.3 https://google.com 2>&1 | grep -i "TLS\|SSL\|cert\|cipher"
```

---

## Diffie-Hellman Key Exchange — The Mathematics

Diffie-Hellman solves a fundamental problem: **two parties can agree on a shared secret over a public channel without ever transmitting the secret itself**. Anyone eavesdropping sees only public values and cannot derive the secret.

### Classic DH (Finite Field)

**Public parameters (known to everyone, including attackers):**
```
p = a large prime number (e.g., 2048-bit)
g = a generator (primitive root mod p, typically g=2 or g=5)
```

**The exchange:**

```mermaid
sequenceDiagram
    participant A as Alice (Client)
    participant NET as Public Network (attacker can see)
    participant B as Bob (Server)

    Note over A,B: Public params agreed in advance: p=23, g=5

    A->>A: Pick secret a=6 (never transmitted)
    A->>A: Compute A = g^a mod p = 5^6 mod 23 = 8
    A->>NET: Send A=8 (public)
    NET->>B: A=8

    B->>B: Pick secret b=15 (never transmitted)
    B->>B: Compute B = g^b mod p = 5^15 mod 23 = 19
    B->>NET: Send B=19 (public)
    NET->>A: B=19

    A->>A: Shared secret = B^a mod p = 19^6 mod 23 = 2
    B->>B: Shared secret = A^b mod p = 8^15 mod 23 = 2
    Note over A,B: Both computed the same secret = 2
    Note over NET: Attacker sees p=23, g=5, A=8, B=19<br>Cannot find secret without solving discrete logarithm
```

**Why it works — the math:**
```
Alice computes: s = B^a mod p = (g^b mod p)^a mod p = g^(ab) mod p
Bob computes:   s = A^b mod p = (g^a mod p)^b mod p = g^(ab) mod p

Both get g^(ab) mod p — the shared secret.
Attacker has A = g^a mod p and B = g^b mod p.
To find a from A = g^a mod p → Discrete Logarithm Problem.
No efficient algorithm known for large p (2048+ bits).
```

**The Discrete Logarithm Problem:** Given `g`, `p`, and `A = g^a mod p`, find `a`. Easy in one direction (exponentiation: fast), computationally infeasible in reverse for large primes.

---

### ECDH — Elliptic Curve Diffie-Hellman (Used in TLS 1.3)

Classic DH uses modular arithmetic. ECDH uses **points on an elliptic curve** — same mathematical structure, but achieves equivalent security with much smaller keys.

```
Elliptic curve equation: y² = x³ + ax + b  (over a finite field)
```

**Why elliptic curves?**

| Algorithm | Key size for ~128-bit security | Key size for ~256-bit security |
|-----------|-------------------------------|-------------------------------|
| Classic DH (finite field) | 3072 bits | 15360 bits |
| ECDH | 256 bits | 512 bits |
| RSA | 3072 bits | 15360 bits |

Smaller keys → faster computation, smaller TLS handshake messages, less CPU.

**Point multiplication on a curve:**

```mermaid
graph LR
    G["Generator point G<br>(public, on the curve)"] -->|"scalar multiplication"| PUB_A["Alice's public key<br>A = a × G<br>(a = Alice's private key scalar)"]
    G -->|"scalar multiplication"| PUB_B["Bob's public key<br>B = b × G<br>(b = Bob's private key scalar)"]
    PUB_A & PUB_B -->|"key agreement"| SECRET["Shared secret<br>S = a × B = b × A = ab × G"]
```

**The math:**
```
Public curve parameters: curve equation + generator point G + field order n

Alice: pick private key a (random integer)
       compute public key A = a × G  (point multiplication on curve)

Bob:   pick private key b (random integer)
       compute public key B = b × G

Alice: shared secret = a × B = a × (b × G) = ab × G
Bob:   shared secret = b × A = b × (a × G) = ab × G

Both get the same point ab × G.
Attacker sees G, A, B. Must find a from A = a × G → Elliptic Curve Discrete Log Problem (ECDLP).
No efficient algorithm known.
```

**Point multiplication** (`a × G`) means: add point G to itself `a` times using the curve's addition law. Repeated doubling makes this O(log a) — fast. Reversing it (finding `a` given `G` and `a × G`) has no known polynomial-time algorithm.

---

### ECDHE — Ephemeral ECDH (what TLS 1.3 actually uses)

ECDHE = ECDH + **Ephemeral**. A new key pair is generated for every TLS session.

```mermaid
sequenceDiagram
    participant C2 as Client
    participant S2 as Server

    Note over C2,S2: TLS 1.3 ECDHE with X25519 curve

    C2->>C2: Generate ephemeral private key c_priv (random, 32 bytes)
    C2->>C2: Compute public key c_pub = c_priv × G
    C2->>S2: ClientHello: key_share = c_pub

    S2->>S2: Generate ephemeral private key s_priv (random, 32 bytes)
    S2->>S2: Compute public key s_pub = s_priv × G
    S2->>S2: Shared secret = s_priv × c_pub = s_priv × c_priv × G
    S2->>C2: ServerHello: key_share = s_pub

    C2->>C2: Shared secret = c_priv × s_pub = c_priv × s_priv × G

    Note over C2,S2: Both derived same shared secret
    Note over C2,S2: Derive session keys via HKDF:
    Note over C2,S2: client_key = HKDF(shared_secret, "client key")
    Note over C2,S2: server_key = HKDF(shared_secret, "server key")

    Note over C2: c_priv discarded after handshake
    Note over S2: s_priv discarded after handshake
    Note over C2,S2: Forward secrecy: past sessions unrecoverable
```

**Why "ephemeral" = forward secrecy:**
- Static DH: server uses the same private key for all sessions. Steal the private key → decrypt all past recorded traffic.
- Ephemeral DH: server generates a new private key per session and **discards it after the handshake**. Steal the long-term private key → can only impersonate future connections, cannot decrypt past traffic. Each session's key material is gone forever.

---

### X25519 — The Curve Used in TLS 1.3

TLS 1.3 mandates support for **X25519** (Curve25519). Designed by Daniel J. Bernstein.

```
Curve equation: y² = x³ + 486662x² + x  (over the field of integers mod 2^255 - 19)
Base point G: u = 9
Field size: 2^255 - 19 (a Mersenne-like prime, chosen for fast arithmetic)
Key size: 256 bits
Security level: ~128 bits
```

**Why X25519 over P-256 (NIST)?**

| | X25519 | P-256 (NIST) |
|--|--------|-------------|
| Speed | Faster (~2× on most CPUs) | Slower |
| Side-channel resistance | Designed to resist timing attacks | Vulnerable without careful implementation |
| Standardized by | IETF RFC 7748 | NIST |
| Trust | No NIST involvement (controversial) | NIST-approved |
| TLS 1.3 | Preferred | Supported |

---

### From Shared Secret to Session Keys (HKDF)

The raw ECDHE output (a point on the curve) is not directly used as an AES key. It goes through **HKDF (HMAC-based Key Derivation Function)**:

```mermaid
graph LR
    ECDHE_OUT["ECDHE shared secret<br>(32 bytes, the x-coordinate of ab×G)"] --> HKDF_EXT
    HKDF_EXT["HKDF-Extract<br>salt + IKM --> PRK<br>(Pseudorandom Key)"] --> HKDF_EXP
    TRANSCRIPT["Handshake transcript hash<br>(all messages so far, prevents replay)"] --> HKDF_EXP
    HKDF_EXP["HKDF-Expand<br>PRK + label + context --> OKM<br>(Output Key Material)"] --> KEYS
    KEYS["client_write_key (AES-256)<br>server_write_key (AES-256)<br>client_write_IV (96-bit nonce)<br>server_write_IV (96-bit nonce)"]
```

The **transcript hash** binds the keys to this specific handshake — prevents man-in-the-middle attacks where an attacker replays a valid key exchange from a different session.

**Summary of TLS 1.3 key derivation:**
```
ECDHE_secret = s_priv × c_pub  (x-coordinate of the curve point)
early_secret = HKDF-Extract(0, PSK or 0)
handshake_secret = HKDF-Extract(derived(early_secret), ECDHE_secret)
master_secret = HKDF-Extract(derived(handshake_secret), 0)

client_handshake_traffic_secret = HKDF-Expand-Label(handshake_secret, "c hs traffic", transcript_hash)
server_handshake_traffic_secret = HKDF-Expand-Label(handshake_secret, "s hs traffic", transcript_hash)
```
