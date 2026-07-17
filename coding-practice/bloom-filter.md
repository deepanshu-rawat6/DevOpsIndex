# Bloom Filter (Go)

Probabilistic set-membership structure: space-efficient, no false negatives, tunable false positive rate. Answers "definitely not present" or "maybe present" — never "definitely present."

---

## Full Working Code

```go
package bloom

import (
	"hash/fnv"
	"math"
)

// Filter is a Bloom filter backed by a bit array and k independent hash
// functions (simulated via double hashing from two base hashes).
type Filter struct {
	bits []uint64 // packed bit array, 64 bits per word
	m    uint     // number of bits
	k    uint     // number of hash functions
}

// NewFilter creates a Bloom filter sized for n expected elements at the
// given target false positive rate p (e.g. 0.01 for 1%).
func NewFilter(n uint, p float64) *Filter {
	m := optimalM(n, p)
	k := optimalK(m, n)
	return &Filter{
		bits: make([]uint64, (m+63)/64), // round up to whole words
		m:    m,
		k:    k,
	}
}

// optimalM computes the number of bits needed: m = -(n * ln(p)) / (ln(2)^2)
func optimalM(n uint, p float64) uint {
	m := -1 * float64(n) * math.Log(p) / (math.Ln2 * math.Ln2)
	return uint(math.Ceil(m))
}

// optimalK computes the ideal number of hash functions: k = (m/n) * ln(2)
func optimalK(m, n uint) uint {
	k := (float64(m) / float64(n)) * math.Ln2
	if k < 1 {
		return 1
	}
	return uint(math.Round(k))
}

// hashes returns two independent base hashes of data. All k hash functions
// are derived from these two via double hashing (Kirsch-Mitzenmacher),
// avoiding the need for k separate hash implementations.
func hashes(data []byte) (uint64, uint64) {
	h1 := fnv.New64a()
	h1.Write(data)
	sum1 := h1.Sum64()

	h2 := fnv.New64()
	h2.Write(data)
	sum2 := h2.Sum64()

	return sum1, sum2
}

// Add inserts an element into the filter.
func (f *Filter) Add(data []byte) {
	h1, h2 := hashes(data)
	for i := uint(0); i < f.k; i++ {
		pos := f.combine(h1, h2, i) % uint64(f.m)
		f.setBit(pos)
	}
}

// MightContain reports whether data may be in the set. False means
// definitely not present. True means present with probability (1 - false
// positive rate) — it might be a false positive.
func (f *Filter) MightContain(data []byte) bool {
	h1, h2 := hashes(data)
	for i := uint(0); i < f.k; i++ {
		pos := f.combine(h1, h2, i) % uint64(f.m)
		if !f.getBit(pos) {
			return false
		}
	}
	return true
}

// combine implements double hashing: hash_i(x) = h1(x) + i*h2(x)
func (f *Filter) combine(h1, h2 uint64, i uint) uint64 {
	return h1 + uint64(i)*h2
}

func (f *Filter) setBit(pos uint64) {
	word := pos / 64
	bit := pos % 64
	f.bits[word] |= 1 << bit
}

func (f *Filter) getBit(pos uint64) bool {
	word := pos / 64
	bit := pos % 64
	return f.bits[word]&(1<<bit) != 0
}

// EstimatedFalsePositiveRate returns the current theoretical false positive
// rate given m, k, and how many elements n have actually been inserted so
// far (tracked externally by the caller, since the filter itself doesn't
// count insertions — duplicate Adds don't increase the "true" n).
func (f *Filter) EstimatedFalsePositiveRate(n uint) float64 {
	exp := -float64(f.k) * float64(n) / float64(f.m)
	return math.Pow(1-math.Exp(exp), float64(f.k))
}
```

### Test cases

```go
package bloom

import "testing"

func TestNoFalseNegatives(t *testing.T) {
	f := NewFilter(1000, 0.01)

	inserted := []string{"apple", "banana", "cherry", "date", "elderberry"}
	for _, s := range inserted {
		f.Add([]byte(s))
	}

	for _, s := range inserted {
		if !f.MightContain([]byte(s)) {
			t.Fatalf("false negative for %q — Bloom filters must never do this", s)
		}
	}
}

func TestDefinitelyAbsent(t *testing.T) {
	f := NewFilter(1000, 0.01)
	f.Add([]byte("present"))

	// Not a guarantee for every unrelated string (false positives are
	// possible), but a filter sized for 1000 elements at 1% FP rate with
	// only 1 element inserted should reject almost everything.
	falsePositives := 0
	trials := 1000
	for i := 0; i < trials; i++ {
		key := []byte{byte(i), byte(i >> 8)}
		if f.MightContain(key) {
			falsePositives++
		}
	}
	// Sanity bound — should be well under the target rate given only 1
	// real insertion, not a tight statistical assertion.
	if falsePositives > trials/10 {
		t.Fatalf("false positive rate too high: %d/%d", falsePositives, trials)
	}
}

func TestFalsePositiveRateNearTarget(t *testing.T) {
	n := uint(10000)
	targetP := 0.01
	f := NewFilter(n, targetP)

	for i := uint(0); i < n; i++ {
		f.Add([]byte{byte(i), byte(i >> 8), byte(i >> 16)})
	}

	// Test with keys guaranteed not to have been inserted.
	falsePositives := 0
	trials := 10000
	for i := 0; i < trials; i++ {
		key := []byte{byte(i), byte(i >> 8), byte(i >> 16), 0xFF} // distinct namespace
		if f.MightContain(key) {
			falsePositives++
		}
	}

	observedRate := float64(falsePositives) / float64(trials)
	t.Logf("observed FP rate: %.4f, target: %.4f", observedRate, targetP)
	// Allow generous margin — this is a probabilistic structure.
	if observedRate > targetP*3 {
		t.Fatalf("observed FP rate %.4f far exceeds target %.4f", observedRate, targetP)
	}
}
```

---

## False Positive Rate Math

Given:
- `m` = number of bits in the array
- `n` = number of elements inserted
- `k` = number of hash functions

**Optimal number of hash functions** (minimizes false positive rate for given m, n):

```
k = (m/n) * ln(2)
```

**False positive probability** after inserting n elements:

```
p ≈ (1 - e^(-kn/m))^k
```

**Required bits for target false positive rate p** (solving for m given n and desired p):

```
m = -(n * ln(p)) / (ln(2))^2
```

### Worked Example

Requirement: store 1,000,000 elements with a 1% (0.01) false positive rate.

```
n = 1,000,000
p = 0.01

Step 1 — compute m:
m = -(1,000,000 * ln(0.01)) / (ln(2))^2
  = -(1,000,000 * -4.6052) / (0.6931)^2
  = 4,605,200 / 0.4805
  ≈ 9,585,000 bits
  ≈ 1.14 MB

Step 2 — compute k:
k = (m/n) * ln(2)
  = (9,585,000 / 1,000,000) * 0.6931
  = 9.585 * 0.6931
  ≈ 6.64  ->  round to 7 hash functions

Step 3 — verify p with rounded k=7, m=9,585,000, n=1,000,000:
p ≈ (1 - e^(-7*1,000,000/9,585,000))^7
  ≈ (1 - e^(-0.7302))^7
  ≈ (1 - 0.4819)^7
  ≈ (0.5181)^7
  ≈ 0.00963   (≈0.96%, close to the 1% target)
```

**Compare to the naive alternative:** storing 1,000,000 actual keys (e.g., 8-byte hashes) in a hashset would take ~8 MB minimum, plus hashmap overhead (buckets, pointers) pushing it to 20-40 MB in practice. The Bloom filter does it in ~1.14 MB — roughly 20-30x less memory — at the cost of ~1% false positives and no ability to enumerate or delete elements (standard Bloom filters don't support deletion; that requires a Counting Bloom Filter variant with counters instead of bits).

---

## Use Cases in Infra Engineering

### 1. Pre-check before an expensive DB lookup

```go
// Avoid a disk-seeking DB query for keys that provably don't exist.
// Example: checking if a username is taken before hitting the DB.
func UsernameExists(filter *Filter, db *sql.DB, username string) (bool, error) {
	if !filter.MightContain([]byte(username)) {
		return false, nil // definitely not taken — skip the DB entirely
	}
	// Might exist (or false positive) — fall through to the authoritative check.
	var exists bool
	err := db.QueryRow(
		"SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)", username,
	).Scan(&exists)
	return exists, err
}
```

This is the pattern behind Cassandra's and RocksDB's SSTable read paths: a Bloom filter per SSTable lets a read skip disk I/O entirely for SSTables that provably don't contain the key, only paying the real read cost when the filter says "maybe."

### 2. Deduplication in stream processing

```go
// Drop duplicate events in a Kafka consumer without storing every seen
// event ID forever. Trade: a small % of unique events may be incorrectly
// dropped as "duplicates" (false positive), but never the reverse.
func ProcessEvent(filter *Filter, event Event, handler func(Event)) {
	id := []byte(event.ID)
	if filter.MightContain(id) {
		return // likely a duplicate — skip (small false-positive-drop risk)
	}
	filter.Add(id)
	handler(event)
}
```

Used for at-least-once delivery systems where occasional duplicate suppression false positives (dropping a genuinely new event because it collided with a filter bit pattern) are acceptable, but exact deduplication via a full seen-set would be too memory-expensive at scale (e.g., billions of event IDs/day).

### 3. Other infra-relevant use cases worth mentioning in an interview

| Use case | Why Bloom filter fits |
|---|---|
| CDN edge cache "definitely not cached" check | Skip origin round-trip metadata lookup for objects never seen at that edge |
| Chrome Safe Browsing (malicious URL check) | Local filter check before an expensive network call to the full blocklist |
| Distributed cache "cache miss" fast-path | Many cache clients query a shared Bloom filter to avoid hammering a cache cluster with guaranteed-miss requests |
| Bitcoin SPV clients | Filter transactions relevant to a wallet without downloading the full chain |
