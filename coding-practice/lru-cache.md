# LRU Cache (Go)

Classic interview problem: design a fixed-capacity cache with O(1) `Get` and `Put`, evicting the least-recently-used entry when full.

---

## Why Doubly Linked List + Hashmap

| Structure alone | Get | Put | Eviction (move/remove from middle) |
|---|---|---|---|
| Hashmap only | O(1) | O(1) | No ordering info — can't know what's "least recently used" |
| Linked list only | O(n) — must scan to find key | O(n) | O(1) once found, but finding it is O(n) |
| **Hashmap + doubly linked list** | **O(1)** — map gives direct node pointer | **O(1)** | **O(1)** — map gives the node, DLL removal/insertion is pointer surgery, no scan |

The hashmap gives O(1) *lookup* of a node by key. The doubly linked list gives O(1) *reordering* (move-to-front on access, remove-from-tail on eviction) because you have a direct pointer to the node's neighbors — no traversal needed. Neither structure alone gets both properties; together they do.

A singly linked list is insufficient because removing a node requires a pointer to its *previous* node, which a singly linked list doesn't give you in O(1) — you'd have to scan from the head.

---

## Full Working Code

```go
package lru

import "container/list"

// entry is the payload stored in each list.Element.
type entry struct {
	key   int
	value int
}

// Cache is a fixed-capacity LRU cache.
// list.Element at the front = most recently used, back = least recently used.
type Cache struct {
	capacity int
	ll       *list.List
	items    map[int]*list.Element
}

// NewCache creates an LRU cache with the given capacity.
// Panics if capacity <= 0, matching common interview expectations for invalid input.
func NewCache(capacity int) *Cache {
	if capacity <= 0 {
		panic("lru: capacity must be positive")
	}
	return &Cache{
		capacity: capacity,
		ll:       list.New(),
		items:    make(map[int]*list.Element, capacity),
	}
}

// Get returns the value for key and marks it as most recently used.
// The second return value reports whether the key was present.
func (c *Cache) Get(key int) (int, bool) {
	elem, ok := c.items[key]
	if !ok {
		return 0, false
	}
	c.ll.MoveToFront(elem)
	return elem.Value.(*entry).value, true
}

// Put inserts or updates key with value, evicting the LRU entry if the
// cache is at capacity and key is new.
func (c *Cache) Put(key int, value int) {
	if elem, ok := c.items[key]; ok {
		elem.Value.(*entry).value = value
		c.ll.MoveToFront(elem)
		return
	}

	if c.ll.Len() >= c.capacity {
		c.evictOldest()
	}

	elem := c.ll.PushFront(&entry{key: key, value: value})
	c.items[key] = elem
}

// Len returns the current number of entries in the cache.
func (c *Cache) Len() int {
	return c.ll.Len()
}

func (c *Cache) evictOldest() {
	oldest := c.ll.Back()
	if oldest == nil {
		return
	}
	c.ll.Remove(oldest)
	delete(c.items, oldest.Value.(*entry).key)
}
```

### Test cases

```go
package lru

import "testing"

func TestCacheBasic(t *testing.T) {
	c := NewCache(2)

	c.Put(1, 100)
	c.Put(2, 200)

	if v, ok := c.Get(1); !ok || v != 100 {
		t.Fatalf("Get(1) = %d, %v; want 100, true", v, ok)
	}

	// Access to key 1 makes it MRU; key 2 becomes LRU.
	c.Put(3, 300) // capacity=2, evicts key 2

	if _, ok := c.Get(2); ok {
		t.Fatal("key 2 should have been evicted")
	}
	if v, ok := c.Get(3); !ok || v != 300 {
		t.Fatalf("Get(3) = %d, %v; want 300, true", v, ok)
	}
	if v, ok := c.Get(1); !ok || v != 100 {
		t.Fatalf("Get(1) = %d, %v; want 100, true", v, ok)
	}
}

func TestCacheUpdateExisting(t *testing.T) {
	c := NewCache(2)
	c.Put(1, 100)
	c.Put(1, 999) // update, not insert

	if c.Len() != 1 {
		t.Fatalf("Len() = %d; want 1", c.Len())
	}
	if v, _ := c.Get(1); v != 999 {
		t.Fatalf("Get(1) = %d; want 999", v)
	}
}

func TestCacheEvictionOrder(t *testing.T) {
	c := NewCache(3)
	c.Put(1, 1)
	c.Put(2, 2)
	c.Put(3, 3)

	c.Get(1) // 1 is now MRU; order (MRU->LRU): 1, 3, 2

	c.Put(4, 4) // evicts 2 (the actual LRU)

	if _, ok := c.Get(2); ok {
		t.Fatal("key 2 should have been evicted, not key 1 or 3")
	}
	if _, ok := c.Get(1); !ok {
		t.Fatal("key 1 should still be present")
	}
	if _, ok := c.Get(3); !ok {
		t.Fatal("key 3 should still be present")
	}
}
```

---

## Complexity Analysis

| Operation | Time | Space |
|---|---|---|
| `Get` | O(1) — map lookup + O(1) list move | — |
| `Put` (new key, under capacity) | O(1) | O(1) additional |
| `Put` (new key, at capacity) | O(1) — one eviction, no scan | O(0) — net zero after eviction |
| `Put` (existing key) | O(1) | — |
| Overall space | O(capacity) | Map + list each hold at most `capacity` entries |

`container/list` in Go's standard library is a doubly linked list, so `Remove`/`PushFront`/`MoveToFront` are all O(1) given an `*list.Element` pointer — which is exactly what the map stores.

---

## Interview Follow-Ups

### 1. Thread-safe version (RWMutex)

Naively wrapping every method in a `sync.Mutex` works but serializes reads unnecessarily. The subtlety: **`Get` in an LRU cache is a write to the underlying structure** (it mutates list order via `MoveToFront`), so a plain `RWMutex` read lock is *not* safe for `Get` — it must take the write lock too.

```go
package lru

import (
	"container/list"
	"sync"
)

type SafeCache struct {
	mu       sync.Mutex // not RWMutex: Get mutates list order, so no true read-only path
	capacity int
	ll       *list.List
	items    map[int]*list.Element
}

func NewSafeCache(capacity int) *SafeCache {
	if capacity <= 0 {
		panic("lru: capacity must be positive")
	}
	return &SafeCache{
		capacity: capacity,
		ll:       list.New(),
		items:    make(map[int]*list.Element, capacity),
	}
}

func (c *SafeCache) Get(key int) (int, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	elem, ok := c.items[key]
	if !ok {
		return 0, false
	}
	c.ll.MoveToFront(elem)
	return elem.Value.(*entry).value, true
}

func (c *SafeCache) Put(key int, value int) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if elem, ok := c.items[key]; ok {
		elem.Value.(*entry).value = value
		c.ll.MoveToFront(elem)
		return
	}
	if c.ll.Len() >= c.capacity {
		oldest := c.ll.Back()
		if oldest != nil {
			c.ll.Remove(oldest)
			delete(c.items, oldest.Value.(*entry).key)
		}
	}
	elem := c.ll.PushFront(&entry{key: key, value: value})
	c.items[key] = elem
}
```

If interviewers push for read concurrency, the real answer is **sharding** (partition keys across N independently-locked sub-caches by hash, like Go's `sync.Map` internals or Java's `ConcurrentHashMap`) rather than trying to make `RWMutex` work — because there is no read-only operation in a pure LRU design.

### 2. LFU cache variant — how it differs

| | LRU | LFU |
|---|---|---|
| Eviction criteria | Least *recently* accessed | Least *frequently* accessed |
| Data structure | 1 doubly linked list + 1 hashmap | 1 hashmap (key→node) + 1 hashmap (freq→doubly linked list of nodes) + min-frequency pointer |
| Tie-breaking | N/A (order is the criteria) | Ties at same frequency broken by recency (each frequency bucket is itself an LRU list) |
| Complexity | O(1) get/put | O(1) get/put, but with higher constant factor — every access requires moving the node to a new frequency bucket, plus updating the min-frequency pointer if the old bucket becomes empty |
| When to prefer | Access recency predicts future access (typical cache workload, e.g. web sessions) | Access frequency predicts future access better than recency (e.g. hot config values accessed at a steady rate, cold data accessed once) |

LFU is meaningfully more complex to implement correctly — the min-frequency pointer bookkeeping is the part candidates usually get wrong (forgetting to bump min-frequency when a bucket empties out after a node moves to freq+1).

### 3. TTL-based eviction variant

Add expiry independent of capacity pressure — an entry can be evicted either for being LRU *or* for being expired, whichever comes first.

```go
package lru

import (
	"container/list"
	"time"
)

type ttlEntry struct {
	key      int
	value    int
	expireAt time.Time
}

type TTLCache struct {
	capacity int
	ttl      time.Duration
	ll       *list.List
	items    map[int]*list.Element
}

func NewTTLCache(capacity int, ttl time.Duration) *TTLCache {
	return &TTLCache{
		capacity: capacity,
		ttl:      ttl,
		ll:       list.New(),
		items:    make(map[int]*list.Element, capacity),
	}
}

func (c *TTLCache) Get(key int) (int, bool) {
	elem, ok := c.items[key]
	if !ok {
		return 0, false
	}
	e := elem.Value.(*ttlEntry)
	if time.Now().After(e.expireAt) {
		c.ll.Remove(elem)
		delete(c.items, key)
		return 0, false
	}
	c.ll.MoveToFront(elem)
	return e.value, true
}

func (c *TTLCache) Put(key int, value int) {
	if elem, ok := c.items[key]; ok {
		e := elem.Value.(*ttlEntry)
		e.value = value
		e.expireAt = time.Now().Add(c.ttl)
		c.ll.MoveToFront(elem)
		return
	}
	if c.ll.Len() >= c.capacity {
		if oldest := c.ll.Back(); oldest != nil {
			c.ll.Remove(oldest)
			delete(c.items, oldest.Value.(*ttlEntry).key)
		}
	}
	elem := c.ll.PushFront(&ttlEntry{key: key, value: value, expireAt: time.Now().Add(c.ttl)})
	c.items[key] = elem
}
```

Two designs to discuss with an interviewer:

- **Lazy expiry (above):** check `expireAt` only on access. Simple, no background goroutine, but memory isn't reclaimed for keys that are never looked up again after expiring.
- **Active expiry:** a background goroutine with a `time.Ticker` sweeps the list (or a separate min-heap ordered by `expireAt`) to proactively evict. Needed if bounded memory matters more than simplicity — Redis uses a hybrid of both (lazy expiry on access + periodic active sampling).
