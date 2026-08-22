# LRU Cache (Go)

Classic interview problem: design a fixed-capacity cache with O(1) `Get` and `Put`, evicting the least-recently-used entry when full.

<div class="quiz-progress" data-quiz-progress>
  <span class="quiz-progress-label">0/0 checks</span>
  <span class="quiz-progress-bar"><span class="quiz-progress-fill"></span></span>
</div>

---

## Why Doubly Linked List + Hashmap

| Structure alone | Get | Put | Eviction (move/remove from middle) |
|---|---|---|---|
| Hashmap only | O(1) | O(1) | No ordering info — can't know what's "least recently used" |
| Linked list only | O(n) — must scan to find key | O(n) | O(1) once found, but finding it is O(n) |
| **Hashmap + doubly linked list** | **O(1)** — map gives direct node pointer | **O(1)** | **O(1)** — map gives the node, DLL removal/insertion is pointer surgery, no scan |

The hashmap gives O(1) *lookup* of a node by key. The doubly linked list gives O(1) *reordering* (move-to-front on access, remove-from-tail on eviction) because you have a direct pointer to the node's neighbors — no traversal needed. Neither structure alone gets both properties; together they do.

A singly linked list is insufficient because removing a node requires a pointer to its *previous* node, which a singly linked list doesn't give you in O(1) — you'd have to scan from the head.

The hashmap never stores values directly — it stores pointers *into* the linked list, so both structures stay perfectly in sync as one unit moves:

```mermaid
graph LR
    subgraph DLL["Doubly linked list: MRU to LRU order"]
        direction LR
        Head["head sentinel, MRU end"] --> N1["node key=1, value=100"]
        N1 --> N3["node key=3, value=300"]
        N3 --> N2["node key=2, value=200"]
        N2 --> Tail["tail sentinel, LRU end, evict here"]
        N1 -.->|prev| Head
        N3 -.->|prev| N1
        N2 -.->|prev| N3
        Tail -.->|prev| N2
    end
    subgraph HM["Hashmap: key to node pointer"]
        K1["key=1"] --> N1
        K3["key=3"] --> N3
        K2["key=2"] --> N2
    end
```

> **Why it matters:** every `Get` walks exactly two pointers — hashmap to node, then node to its neighbors during the move — never the whole list. That's the entire O(1) trick in one picture.

<div class="quiz-card">
  <p class="quiz-q">Why do you need both the hashmap and the doubly linked list — what does each one give you that the other can't?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    The hashmap gives O(1) <em>lookup</em> of a node by key, but carries no ordering information. The doubly linked list gives O(1) <em>reordering</em> &mdash; move-to-front on access, remove-from-tail on eviction &mdash; because a direct pointer to a node's neighbors avoids any scan. Neither structure alone gets both properties; together they do.
  </div>
</div>

---

## Full Working Code

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="cache-go" class="active">Go</button>
    <button data-tab="cache-py">Python</button>
    <button data-tab="cache-java">Java</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="cache-go">
      <pre><code class="language-go">package lru
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
// Panics if capacity &lt;= 0, matching common interview expectations for invalid input.
func NewCache(capacity int) *Cache {
	if capacity &lt;= 0 {
		panic("lru: capacity must be positive")
	}
	return &amp;Cache{
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
	if c.ll.Len() &gt;= c.capacity {
		c.evictOldest()
	}
	elem := c.ll.PushFront(&amp;entry{key: key, value: value})
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
}</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="cache-py">
      <pre><code class="language-python">from typing import Optional
class _Node:
    """Doubly linked list node holding one cache entry."""
    __slots__ = ("key", "value", "prev", "next")
    def __init__(self, key: int, value: int) -&gt; None:
        self.key = key
        self.value = value
        self.prev: Optional["_Node"] = None
        self.next: Optional["_Node"] = None
class LRUCache:
    """Fixed-capacity LRU cache with O(1) get/put.
    Two sentinel nodes (head, tail) bound the list so push/remove never
    need a None check on a real entry's neighbor:
    head &lt;-&gt; most-recently-used &lt;-&gt; ... &lt;-&gt; least-recently-used &lt;-&gt; tail.
    Raises ValueError if capacity &lt;= 0, matching common interview
    expectations for invalid input.
    """
    def __init__(self, capacity: int) -&gt; None:
        if capacity &lt;= 0:
            raise ValueError("lru: capacity must be positive")
        self.capacity = capacity
        self._items: dict[int, _Node] = {}
        self._head = _Node(0, 0)
        self._tail = _Node(0, 0)
        self._head.next = self._tail
        self._tail.prev = self._head
    def get(self, key: int) -&gt; Optional[int]:
        """Return the value for key and mark it most recently used.
        Returns None if the key is absent (0 is a valid stored value,
        so this cache can't reuse a sentinel return the way Go's
        two-value return does -- callers needing to store None as a
        real value should wrap it, e.g. in an Optional marker object).
        """
        node = self._items.get(key)
        if node is None:
            return None
        self._move_to_front(node)
        return node.value
    def put(self, key: int, value: int) -&gt; None:
        """Insert or update key with value.
        Evicts the least-recently-used entry first if the cache is at
        capacity and key is new.
        """
        node = self._items.get(key)
        if node is not None:
            node.value = value
            self._move_to_front(node)
            return
        if len(self._items) &gt;= self.capacity:
            self._evict_oldest()
        node = _Node(key, value)
        self._items[key] = node
        self._push_front(node)
    def __len__(self) -&gt; int:
        """Return the current number of entries in the cache."""
        return len(self._items)
    def _push_front(self, node: "_Node") -&gt; None:
        node.prev = self._head
        node.next = self._head.next
        self._head.next.prev = node
        self._head.next = node
    def _remove(self, node: "_Node") -&gt; None:
        node.prev.next = node.next
        node.next.prev = node.prev
    def _move_to_front(self, node: "_Node") -&gt; None:
        self._remove(node)
        self._push_front(node)
    def _evict_oldest(self) -&gt; None:
        oldest = self._tail.prev
        if oldest is self._head:
            return
        self._remove(oldest)
        del self._items[oldest.key]</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="cache-java">
      <pre><code class="language-java">import java.util.HashMap;
import java.util.Map;
// Idiomatic Java shortcut: `new LinkedHashMap&lt;&gt;(cap, 0.75f, true)` with an
// overridden removeEldestEntry() gives LRU eviction in ~10 lines. The
// manual doubly-linked-list + hashmap version below is the interview-
// expected approach, matching the Go/Python implementations above.
public class LRUCache {
    private static class Node {
        final int key;
        int value;
        Node prev;
        Node next;
        Node(int key, int value) {
            this.key = key;
            this.value = value;
        }
    }
    private final int capacity;
    private final Map&lt;Integer, Node&gt; items;
    private final Node head;
    private final Node tail;
    /** Creates an LRU cache with the given capacity. Throws if capacity &lt;= 0. */
    public LRUCache(int capacity) {
        if (capacity &lt;= 0) {
            throw new IllegalArgumentException("lru: capacity must be positive");
        }
        this.capacity = capacity;
        this.items = new HashMap&lt;&gt;(capacity);
        this.head = new Node(0, 0);
        this.tail = new Node(0, 0);
        head.next = tail;
        tail.prev = head;
    }
    /** Returns the value for key and marks it most recently used, or null if absent. */
    public Integer get(int key) {
        Node node = items.get(key);
        if (node == null) {
            return null;
        }
        moveToFront(node);
        return node.value;
    }
    /** Inserts or updates key with value, evicting the LRU entry first if full and key is new. */
    public void put(int key, int value) {
        Node node = items.get(key);
        if (node != null) {
            node.value = value;
            moveToFront(node);
            return;
        }
        if (items.size() &gt;= capacity) {
            evictOldest();
        }
        node = new Node(key, value);
        items.put(key, node);
        pushFront(node);
    }
    /** Returns the current number of entries in the cache. */
    public int size() {
        return items.size();
    }
    private void pushFront(Node node) {
        node.prev = head;
        node.next = head.next;
        head.next.prev = node;
        head.next = node;
    }
    private void remove(Node node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }
    private void moveToFront(Node node) {
        remove(node);
        pushFront(node);
    }
    private void evictOldest() {
        Node oldest = tail.prev;
        if (oldest == head) {
            return;
        }
        remove(oldest);
        items.remove(oldest.key);
    }
}</code></pre>
    </div>
  </div>
</div>

### Test cases

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="tests-go" class="active">Go</button>
    <button data-tab="tests-py">Python</button>
    <button data-tab="tests-java">Java</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="tests-go">
      <pre><code class="language-go">package lru
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
	c.Get(1) // 1 is now MRU; order (MRU-&gt;LRU): 1, 3, 2
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
}</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="tests-py">
      <pre><code class="language-python">import unittest
class TestLRUCache(unittest.TestCase):
    def test_basic(self) -&gt; None:
        cache = LRUCache(2)
        cache.put(1, 100)
        cache.put(2, 200)
        self.assertEqual(cache.get(1), 100)
        # Access to key 1 makes it MRU; key 2 becomes LRU.
        cache.put(3, 300)  # capacity=2, evicts key 2
        self.assertIsNone(cache.get(2))
        self.assertEqual(cache.get(3), 300)
        self.assertEqual(cache.get(1), 100)
    def test_update_existing(self) -&gt; None:
        cache = LRUCache(2)
        cache.put(1, 100)
        cache.put(1, 999)  # update, not insert
        self.assertEqual(len(cache), 1)
        self.assertEqual(cache.get(1), 999)
    def test_eviction_order(self) -&gt; None:
        cache = LRUCache(3)
        cache.put(1, 1)
        cache.put(2, 2)
        cache.put(3, 3)
        cache.get(1)  # 1 is now MRU; order (MRU-&gt;LRU): 1, 3, 2
        cache.put(4, 4)  # evicts 2 (the actual LRU)
        self.assertIsNone(cache.get(2))
        self.assertIsNotNone(cache.get(1))
        self.assertIsNotNone(cache.get(3))
if __name__ == "__main__":
    unittest.main()</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="tests-java">
      <pre><code class="language-java">public class LRUCacheTest {
    public static void main(String[] args) {
        testBasic();
        testUpdateExisting();
        testEvictionOrder();
        System.out.println("ALL TESTS PASSED");
    }
    static void testBasic() {
        LRUCache cache = new LRUCache(2);
        cache.put(1, 100);
        cache.put(2, 200);
        assertEquals(100, cache.get(1), "Get(1)");
        // Access to key 1 makes it MRU; key 2 becomes LRU.
        cache.put(3, 300); // capacity=2, evicts key 2
        assertNull(cache.get(2), "key 2 should have been evicted");
        assertEquals(300, cache.get(3), "Get(3)");
        assertEquals(100, cache.get(1), "Get(1)");
        System.out.println("PASS testBasic");
    }
    static void testUpdateExisting() {
        LRUCache cache = new LRUCache(2);
        cache.put(1, 100);
        cache.put(1, 999); // update, not insert
        assertEquals(1, cache.size(), "size()");
        assertEquals(999, cache.get(1), "Get(1)");
        System.out.println("PASS testUpdateExisting");
    }
    static void testEvictionOrder() {
        LRUCache cache = new LRUCache(3);
        cache.put(1, 1);
        cache.put(2, 2);
        cache.put(3, 3);
        cache.get(1); // 1 is now MRU; order (MRU-&gt;LRU): 1, 3, 2
        cache.put(4, 4); // evicts 2 (the actual LRU)
        assertNull(cache.get(2), "key 2 should have been evicted, not key 1 or 3");
        assertNotNull(cache.get(1), "key 1 should still be present");
        assertNotNull(cache.get(3), "key 3 should still be present");
        System.out.println("PASS testEvictionOrder");
    }
    static void assertEquals(int expected, Integer actual, String msg) {
        if (actual == null || actual != expected) {
            throw new AssertionError(msg + ": expected " + expected + " but got " + actual);
        }
    }
    static void assertNull(Integer actual, String msg) {
        if (actual != null) {
            throw new AssertionError(msg + ": expected null but got " + actual);
        }
    }
    static void assertNotNull(Integer actual, String msg) {
        if (actual == null) {
            throw new AssertionError(msg + ": expected non-null value");
        }
    }
}</code></pre>
    </div>
  </div>
</div>

### Walkthrough: a Get/Put sequence that causes an eviction

The diagram above shows the structure frozen in time. This walks through the same `TestCacheEvictionOrder` scenario one operation at a time, so you can see exactly when the eviction candidate changes:

<div class="stepper">
  <div class="stepper-panels">
    <div class="stepper-panel active">
      <strong>1. Start.</strong> Capacity 3, empty cache. Hashmap: <code>{}</code>. List: empty.
    </div>
    <div class="stepper-panel">
      <strong>2. Put(1, 1).</strong> New node pushed to the front. List (MRU&rarr;LRU): <code>1</code>. Hashmap: <code>{1: node1}</code>.
    </div>
    <div class="stepper-panel">
      <strong>3. Put(2, 2).</strong> Another new node pushed to the front. List: <code>2, 1</code>. Hashmap: <code>{1, 2}</code>.
    </div>
    <div class="stepper-panel">
      <strong>4. Put(3, 3).</strong> List: <code>3, 2, 1</code>. Cache is now full: 3/3. Key 1 is currently the tail — the eviction candidate, for now.
    </div>
    <div class="stepper-panel">
      <strong>5. Get(1).</strong> Hashmap hands back a direct pointer to node 1 &mdash; no scan. MoveToFront makes it MRU. List: <code>1, 3, 2</code>. Key 2 is now the tail &mdash; the eviction candidate has changed.
    </div>
    <div class="stepper-panel">
      <strong>6. Put(4, 4).</strong> Cache is at capacity and key 4 is new, so evict the tail first: the list's tail pointer goes straight to node 2, no scan needed &mdash; remove it from the list and delete key 2 from the hashmap. Then push node 4 to the front. Final list: <code>4, 1, 3</code>. Hashmap: <code>{1, 3, 4}</code> &mdash; key 2 is gone.
    </div>
  </div>
  <div class="stepper-controls">
    <button class="stepper-prev">← Prev</button>
    <span class="stepper-dots"></span>
    <span class="stepper-label"></span>
    <button class="stepper-next">Next →</button>
  </div>
</div>

## Try It Yourself: Live LRU Cache

Same capacity-3 cache, same starting point as the walkthrough above (after `Put(1)`, `Put(2)`, `Put(3)`) — except this one's live. Get an existing key to watch it jump to MRU, or insert a new one once it's full to watch the LRU slot get evicted.

<div class="structure-viz" id="lru-live-viz">
  <svg class="viz-canvas" viewBox="0 0 400 120"></svg>
  <div class="viz-controls">
    <input class="viz-input" type="number" placeholder="key" />
    <button class="viz-btn" data-viz-action="insert">Put</button>
    <button class="viz-btn" data-viz-action="search">Get</button>
    <button class="viz-btn viz-btn-danger" data-viz-action="delete">Delete</button>
    <button class="viz-btn" data-viz-action="reset">Reset</button>
  </div>
  <div class="viz-status"></div>
  <div class="viz-legend">
    <span><span class="viz-swatch" style="background:#1e3a8a"></span> cached key</span>
    <span><span class="viz-swatch" style="background:#14532d"></span> just inserted</span>
    <span><span class="viz-swatch" style="background:#78350f"></span> just accessed / promoted</span>
  </div>
</div>

<script>
(function () {
  const svgNS = 'http://www.w3.org/2000/svg';
  const root0 = document.getElementById('lru-live-viz');
  const svg = root0.querySelector('.viz-canvas');
  const input = root0.querySelector('.viz-input');
  const status = root0.querySelector('.viz-status');

  const CAPACITY = 3;
  const SLOT_W = 90, SLOT_H = 46, GAP = 16;

  let order, newKey, flashKey, flashTimer;

  function reset() {
    order = [3, 2, 1]; // MRU -> LRU; matches the walkthrough's step-4 state (put 1,2,3)
    newKey = null;
    flashKey = null;
  }

  function put(key) {
    const idx = order.indexOf(key);
    if (idx !== -1) {
      order.splice(idx, 1);
      order.unshift(key);
      newKey = null;
      flashKey = key;
      setStatus(`${key} was already cached — a Put on an existing key promotes it to most-recently-used, same as a Get would.`, 'ok');
      return;
    }
    let evicted = null;
    if (order.length >= CAPACITY) evicted = order.pop();
    order.unshift(key);
    newKey = key;
    flashKey = null;
    setStatus(
      evicted !== null
        ? `Inserted ${key} — cache was full, so the least-recently-used key (${evicted}) was evicted first.`
        : `Inserted ${key} — room to spare, no eviction needed (${order.length}/${CAPACITY}).`,
      'ok'
    );
  }

  function doGet(key) {
    const idx = order.indexOf(key);
    if (idx === -1) { setStatus(`${key} — cache miss.`, 'error'); flashKey = null; newKey = null; return; }
    order.splice(idx, 1);
    order.unshift(key);
    newKey = null;
    flashKey = key;
    setStatus(`${key} — cache hit, promoted to most-recently-used.`, 'ok');
  }

  function doDelete(key) {
    const idx = order.indexOf(key);
    if (idx === -1) { setStatus(`${key} isn't cached — nothing to delete.`, 'error'); return; }
    order.splice(idx, 1);
    newKey = null;
    flashKey = null;
    setStatus(`Removed ${key} from the cache (${order.length}/${CAPACITY} now used).`, 'ok');
  }

  function scheduleFlashClear() {
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { newKey = null; flashKey = null; draw(); }, 1600);
  }

  function setStatus(msg, kind) {
    status.textContent = msg;
    status.className = 'viz-status' + (kind === 'ok' ? ' viz-status-ok' : kind === 'error' ? ' viz-status-error' : '');
  }

  function el(tag, attrs) {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function draw() {
    const vbW = CAPACITY * (SLOT_W + GAP) + GAP;
    const vbH = 110;
    svg.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    for (let i = 0; i < CAPACITY; i++) {
      const x = GAP + i * (SLOT_W + GAP);
      const y = 34;
      const key = order[i];
      const occupied = key !== undefined;
      let cls = 'viz-node';
      if (occupied && key === newKey) cls = 'viz-node-new';
      else if (occupied && key === flashKey) cls = 'viz-node-highlight';
      svg.appendChild(el('rect', {
        x, y, width: SLOT_W, height: SLOT_H, rx: 6,
        class: occupied ? cls : 'viz-edge',
        'fill-opacity': occupied ? '1' : '0', 'stroke-dasharray': occupied ? '' : '4,3',
      }));
      if (occupied) {
        const t = el('text', { x: x + SLOT_W / 2, y: y + SLOT_H / 2 });
        t.textContent = key;
        svg.appendChild(t);
      }
      const label = el('text', { x: x + SLOT_W / 2, y: 16, class: 'viz-label-dim' });
      label.textContent = i === 0 ? 'MRU' : (i === CAPACITY - 1 ? 'LRU (evict next)' : '');
      svg.appendChild(label);
      if (i < CAPACITY - 1) {
        svg.appendChild(el('line', {
          x1: x + SLOT_W, y1: y + SLOT_H / 2, x2: x + SLOT_W + GAP, y2: y + SLOT_H / 2, class: 'viz-edge',
        }));
      }
    }
  }

  root0.querySelector('[data-viz-action="insert"]').addEventListener('click', () => {
    const v = parseInt(input.value, 10);
    if (isNaN(v)) { setStatus('Enter a number first.', 'error'); return; }
    put(v);
    input.value = '';
    draw();
    scheduleFlashClear();
  });

  root0.querySelector('[data-viz-action="search"]').addEventListener('click', () => {
    const v = parseInt(input.value, 10);
    if (isNaN(v)) { setStatus('Enter a number first.', 'error'); return; }
    doGet(v);
    draw();
    scheduleFlashClear();
  });

  root0.querySelector('[data-viz-action="delete"]').addEventListener('click', () => {
    const v = parseInt(input.value, 10);
    if (isNaN(v)) { setStatus('Enter a number first.', 'error'); return; }
    doDelete(v);
    draw();
  });

  root0.querySelector('[data-viz-action="reset"]').addEventListener('click', () => {
    reset();
    setStatus('Reset to the walkthrough’s step-4 state: Put(1), Put(2), Put(3) already applied.', '');
    draw();
  });

  reset();
  setStatus('Loaded at the walkthrough’s step-4 state (Put 1, 2, 3 already applied, cache full) — try Get(1) to see the eviction candidate change, then Put(4) to see the eviction.', '');
  draw();
})();
</script>

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

<div class="quiz-card">
  <p class="quiz-q">Why is evicting the LRU entry O(1) instead of O(n) — isn't finding "the least recently used one" a search?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    No search is needed: the doubly linked list's tail is <em>always</em> the LRU entry by construction, because every access or insert moves its node to the front. Eviction is just "remove whatever's currently at the tail" &mdash; direct pointer surgery, not a scan to find the oldest entry.
  </div>
</div>

---

## Interview Follow-Ups

### 1. Thread-safe version (RWMutex)

Naively wrapping every method in a `sync.Mutex` works but serializes reads unnecessarily. The subtlety: **`Get` in an LRU cache is a write to the underlying structure** (it mutates list order via `MoveToFront`), so a plain `RWMutex` read lock is *not* safe for `Get` — it must take the write lock too.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="safe-go" class="active">Go</button>
    <button data-tab="safe-py">Python</button>
    <button data-tab="safe-java">Java</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="safe-go">
      <pre><code class="language-go">package lru
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
	if capacity &lt;= 0 {
		panic("lru: capacity must be positive")
	}
	return &amp;SafeCache{
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
	if c.ll.Len() &gt;= c.capacity {
		oldest := c.ll.Back()
		if oldest != nil {
			c.ll.Remove(oldest)
			delete(c.items, oldest.Value.(*entry).key)
		}
	}
	elem := c.ll.PushFront(&amp;entry{key: key, value: value})
	c.items[key] = elem
}</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="safe-py">
      <pre><code class="language-python">import threading
from typing import Optional
# Reuses _Node from the base LRUCache module above (same file/module,
# same as Go's SafeCache reuses `entry` from the same package).
class SafeLRUCache:
    """Thread-safe LRU cache.
    Uses a plain Lock, not an RLock or a reader/writer lock: get()
    mutates list order via _move_to_front, so there is no true
    read-only path an RWLock's shared read-lock could safely cover.
    """
    def __init__(self, capacity: int) -&gt; None:
        if capacity &lt;= 0:
            raise ValueError("lru: capacity must be positive")
        self.capacity = capacity
        self._lock = threading.Lock()
        self._items: dict[int, _Node] = {}
        self._head = _Node(0, 0)
        self._tail = _Node(0, 0)
        self._head.next = self._tail
        self._tail.prev = self._head
    def get(self, key: int) -&gt; Optional[int]:
        with self._lock:
            node = self._items.get(key)
            if node is None:
                return None
            self._move_to_front(node)
            return node.value
    def put(self, key: int, value: int) -&gt; None:
        with self._lock:
            node = self._items.get(key)
            if node is not None:
                node.value = value
                self._move_to_front(node)
                return
            if len(self._items) &gt;= self.capacity:
                self._evict_oldest()
            node = _Node(key, value)
            self._items[key] = node
            self._push_front(node)
    def _push_front(self, node: "_Node") -&gt; None:
        node.prev = self._head
        node.next = self._head.next
        self._head.next.prev = node
        self._head.next = node
    def _remove(self, node: "_Node") -&gt; None:
        node.prev.next = node.next
        node.next.prev = node.prev
    def _move_to_front(self, node: "_Node") -&gt; None:
        self._remove(node)
        self._push_front(node)
    def _evict_oldest(self) -&gt; None:
        oldest = self._tail.prev
        if oldest is self._head:
            return
        self._remove(oldest)
        del self._items[oldest.key]</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="safe-java">
      <pre><code class="language-java">import java.util.HashMap;
import java.util.Map;
// Reuses the Node type from LRUCache above (same file/package, same as
// Go's SafeCache reusing `entry` and Python's SafeLRUCache reusing _Node).
public class SafeLRUCache {
    // Not a ReadWriteLock: get() mutates list order via moveToFront, so
    // there is no true read-only path a read lock could safely cover.
    private final Object lock = new Object();
    private final int capacity;
    private final Map&lt;Integer, Node&gt; items;
    private final Node head;
    private final Node tail;
    public SafeLRUCache(int capacity) {
        if (capacity &lt;= 0) {
            throw new IllegalArgumentException("lru: capacity must be positive");
        }
        this.capacity = capacity;
        this.items = new HashMap&lt;&gt;(capacity);
        this.head = new Node(0, 0);
        this.tail = new Node(0, 0);
        head.next = tail;
        tail.prev = head;
    }
    public Integer get(int key) {
        synchronized (lock) {
            Node node = items.get(key);
            if (node == null) {
                return null;
            }
            moveToFront(node);
            return node.value;
        }
    }
    public void put(int key, int value) {
        synchronized (lock) {
            Node node = items.get(key);
            if (node != null) {
                node.value = value;
                moveToFront(node);
                return;
            }
            if (items.size() &gt;= capacity) {
                Node oldest = tail.prev;
                if (oldest != head) {
                    remove(oldest);
                    items.remove(oldest.key);
                }
            }
            node = new Node(key, value);
            items.put(key, node);
            pushFront(node);
        }
    }
    private void pushFront(Node node) {
        node.prev = head;
        node.next = head.next;
        head.next.prev = node;
        head.next = node;
    }
    private void remove(Node node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }
    private void moveToFront(Node node) {
        remove(node);
        pushFront(node);
    }
}</code></pre>
    </div>
  </div>
</div>

If interviewers push for read concurrency, the real answer is **sharding** (partition keys across N independently-locked sub-caches by hash, like Go's `sync.Map` internals or Java's `ConcurrentHashMap`) rather than trying to make `RWMutex` work — because there is no read-only operation in a pure LRU design.

<div class="quiz-card">
  <p class="quiz-q">Why can't <code>Get</code> use just a read lock (<code>RWMutex.RLock</code>) in a thread-safe LRU cache?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Because <code>Get</code> calls <code>MoveToFront</code>, which mutates the list's pointers to reorder it &mdash; that's a write to shared state even though it "just reads" a value. A read lock is only safe when nothing concurrent is mutating shared state, so <code>Get</code> has to take the same exclusive lock <code>Put</code> does. There is no true read-only path in a pure LRU design.
  </div>
</div>

### 2. LFU cache variant — how it differs

| | LRU | LFU |
|---|---|---|
| Eviction criteria | Least *recently* accessed | Least *frequently* accessed |
| Data structure | 1 doubly linked list + 1 hashmap | 1 hashmap (key→node) + 1 hashmap (freq→doubly linked list of nodes) + min-frequency pointer |
| Tie-breaking | N/A (order is the criteria) | Ties at same frequency broken by recency (each frequency bucket is itself an LRU list) |
| Complexity | O(1) get/put | O(1) get/put, but with higher constant factor — every access requires moving the node to a new frequency bucket, plus updating the min-frequency pointer if the old bucket becomes empty |
| When to prefer | Access recency predicts future access (typical cache workload, e.g. web sessions) | Access frequency predicts future access better than recency (e.g. hot config values accessed at a steady rate, cold data accessed once) |

LFU is meaningfully more complex to implement correctly — the min-frequency pointer bookkeeping is the part candidates usually get wrong (forgetting to bump min-frequency when a bucket empties out after a node moves to freq+1).

<div class="quiz-card">
  <p class="quiz-q">What's the classic implementation mistake in an LFU cache's min-frequency bookkeeping?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Forgetting to bump the min-frequency pointer when a node moves from its old frequency bucket to freq+1 and that old bucket becomes empty. If min-frequency isn't advanced, the next eviction looks in the wrong, now-empty bucket instead of the real least-frequently-used one.
  </div>
</div>

### 3. TTL-based eviction variant

Add expiry independent of capacity pressure — an entry can be evicted either for being LRU *or* for being expired, whichever comes first.

<div class="tab-group">
  <div class="tab-buttons">
    <button data-tab="ttl-go" class="active">Go</button>
    <button data-tab="ttl-py">Python</button>
    <button data-tab="ttl-java">Java</button>
  </div>
  <div class="tab-panels">
    <div class="tab-panel active" data-tab-panel="ttl-go">
      <pre><code class="language-go">package lru
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
	return &amp;TTLCache{
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
	if c.ll.Len() &gt;= c.capacity {
		if oldest := c.ll.Back(); oldest != nil {
			c.ll.Remove(oldest)
			delete(c.items, oldest.Value.(*ttlEntry).key)
		}
	}
	elem := c.ll.PushFront(&amp;ttlEntry{key: key, value: value, expireAt: time.Now().Add(c.ttl)})
	c.items[key] = elem
}</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="ttl-py">
      <pre><code class="language-python">import time
from typing import Optional
class _TTLNode:
    """Doubly linked list node holding one cache entry plus its expiry."""
    __slots__ = ("key", "value", "expire_at", "prev", "next")
    def __init__(self, key: int, value: int, expire_at: float) -&gt; None:
        self.key = key
        self.value = value
        self.expire_at = expire_at
        self.prev: Optional["_TTLNode"] = None
        self.next: Optional["_TTLNode"] = None
class TTLCache:
    """LRU cache with lazy TTL expiry layered on top.
    An entry is evicted for whichever comes first: being the
    least-recently-used one when the cache is full, or being past
    its expire_at the next time anyone calls get() on it.
    """
    def __init__(self, capacity: int, ttl_seconds: float) -&gt; None:
        self.capacity = capacity
        self.ttl_seconds = ttl_seconds
        self._items: dict[int, _TTLNode] = {}
        self._head = _TTLNode(0, 0, 0.0)
        self._tail = _TTLNode(0, 0, 0.0)
        self._head.next = self._tail
        self._tail.prev = self._head
    def get(self, key: int) -&gt; Optional[int]:
        node = self._items.get(key)
        if node is None:
            return None
        if time.monotonic() &gt; node.expire_at:
            self._remove(node)
            del self._items[key]
            return None
        self._move_to_front(node)
        return node.value
    def put(self, key: int, value: int) -&gt; None:
        node = self._items.get(key)
        if node is not None:
            node.value = value
            node.expire_at = time.monotonic() + self.ttl_seconds
            self._move_to_front(node)
            return
        if len(self._items) &gt;= self.capacity:
            self._evict_oldest()
        node = _TTLNode(key, value, time.monotonic() + self.ttl_seconds)
        self._items[key] = node
        self._push_front(node)
    def _push_front(self, node: "_TTLNode") -&gt; None:
        node.prev = self._head
        node.next = self._head.next
        self._head.next.prev = node
        self._head.next = node
    def _remove(self, node: "_TTLNode") -&gt; None:
        node.prev.next = node.next
        node.next.prev = node.prev
    def _move_to_front(self, node: "_TTLNode") -&gt; None:
        self._remove(node)
        self._push_front(node)
    def _evict_oldest(self) -&gt; None:
        oldest = self._tail.prev
        if oldest is self._head:
            return
        self._remove(oldest)
        del self._items[oldest.key]</code></pre>
    </div>
    <div class="tab-panel" data-tab-panel="ttl-java">
      <pre><code class="language-java">import java.util.HashMap;
import java.util.Map;
// LRU cache with lazy TTL expiry layered on top. An entry is evicted for
// whichever comes first: being the least-recently-used one when the cache
// is full, or being past its expireAt the next time anyone calls get() on
// it.
public class TTLCache {
    private static class TTLNode {
        final int key;
        int value;
        long expireAt; // System.nanoTime() timestamp -- monotonic, like Python's time.monotonic()
        TTLNode prev;
        TTLNode next;
        TTLNode(int key, int value, long expireAt) {
            this.key = key;
            this.value = value;
            this.expireAt = expireAt;
        }
    }
    private final int capacity;
    private final long ttlNanos;
    private final Map&lt;Integer, TTLNode&gt; items;
    private final TTLNode head;
    private final TTLNode tail;
    public TTLCache(int capacity, long ttlNanos) {
        this.capacity = capacity;
        this.ttlNanos = ttlNanos;
        this.items = new HashMap&lt;&gt;(capacity);
        this.head = new TTLNode(0, 0, 0);
        this.tail = new TTLNode(0, 0, 0);
        head.next = tail;
        tail.prev = head;
    }
    public Integer get(int key) {
        TTLNode node = items.get(key);
        if (node == null) {
            return null;
        }
        if (System.nanoTime() &gt; node.expireAt) {
            remove(node);
            items.remove(key);
            return null;
        }
        moveToFront(node);
        return node.value;
    }
    public void put(int key, int value) {
        TTLNode node = items.get(key);
        if (node != null) {
            node.value = value;
            node.expireAt = System.nanoTime() + ttlNanos;
            moveToFront(node);
            return;
        }
        if (items.size() &gt;= capacity) {
            evictOldest();
        }
        node = new TTLNode(key, value, System.nanoTime() + ttlNanos);
        items.put(key, node);
        pushFront(node);
    }
    private void pushFront(TTLNode node) {
        node.prev = head;
        node.next = head.next;
        head.next.prev = node;
        head.next = node;
    }
    private void remove(TTLNode node) {
        node.prev.next = node.next;
        node.next.prev = node.prev;
    }
    private void moveToFront(TTLNode node) {
        remove(node);
        pushFront(node);
    }
    private void evictOldest() {
        TTLNode oldest = tail.prev;
        if (oldest == head) {
            return;
        }
        remove(oldest);
        items.remove(oldest.key);
    }
}</code></pre>
    </div>
  </div>
</div>

Two designs to discuss with an interviewer — flip between them:

<div class="toggle-switch">
  <div class="toggle-buttons">
    <button data-toggle-opt="lazy" class="active">Lazy expiry</button>
    <button data-toggle-opt="active-expiry">Active expiry</button>
  </div>
  <div class="toggle-panel active" data-toggle-panel="lazy">
    What the code above does: check <code>expireAt</code> only when someone calls <code>Get</code>. No background work at all &mdash; the tradeoff is a key that's expired but never looked up again just sits there, unreclaimed.
  </div>
  <div class="toggle-panel" data-toggle-panel="active-expiry">
    A separate sweeper (ticker or min-heap ordered by <code>expireAt</code>) proactively evicts expired entries whether or not anyone ever calls <code>Get</code> on them again &mdash; the tradeoff is the extra background machinery.
  </div>
</div>

The lazy path above, as a flow:

```mermaid
flowchart LR
    G["Get(key)"] --> H{"key in hashmap?"}
    H -->|no| M["return miss"]
    H -->|yes| E{"now after expireAt?"}
    E -->|yes| X["remove node, delete key, return miss"]
    E -->|no| F["MoveToFront, return value"]
```

- **Lazy expiry (above):** check `expireAt` only on access. Simple, no background goroutine, but memory isn't reclaimed for keys that are never looked up again after expiring.
- **Active expiry:** a background goroutine with a `time.Ticker` sweeps the list (or a separate min-heap ordered by `expireAt`) to proactively evict. Needed if bounded memory matters more than simplicity — Redis uses a hybrid of both (lazy expiry on access + periodic active sampling).

<div class="quiz-card">
  <p class="quiz-q">In the TTL cache, what determines whether an entry gets evicted for being LRU versus for being expired?</p>
  <button class="quiz-reveal">Reveal answer</button>
  <div class="quiz-a" hidden>
    Whichever comes first: capacity pressure evicts the current tail (the LRU entry) regardless of its TTL, while a <code>Get</code> on an individual key evicts it immediately if <code>now</code> is past its <code>expireAt</code>, even if it's nowhere near being the LRU entry. The two eviction paths are independent of each other.
  </div>
</div>
