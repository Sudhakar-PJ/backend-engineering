# WeakRef & FinalizationRegistry

`WeakRef` and `FinalizationRegistry` are low-level ECMAScript features that interact directly with V8's Garbage Collector.

---

## 1. `WeakRef` Mechanics & Usage

A standard reference (strong reference) prevents an object from being garbage collected. A `WeakRef` creates a weak reference to a target object, allowing V8 to collect the target object whenever GC runs if no other strong references exist.

```typescript
// 1. Target object allocated in heap
let largeData: { payload: string } | null = { payload: "100MB JSON String" };

// 2. Wrap in WeakRef
const weakRef = new WeakRef(largeData);

// 3. Accessing the object while strong reference exists
console.log(weakRef.deref()?.payload); // Output: "100MB JSON String"

// 4. Remove strong reference
largeData = null;

// After GC runs, weakRef.deref() will return `undefined`
```

### `deref()` Contract
- `weakRef.deref()` returns the target object if it is still alive in memory.
- If V8 has reclaimed the target object, `deref()` returns `undefined`.

---

## 2. `FinalizationRegistry` Mechanics

`FinalizationRegistry` allows you to register an object with a callback that gets invoked *after* the object has been garbage collected.

```typescript
// Create a registry with a finalizer callback
const registry = new FinalizationRegistry((heldValue: string) => {
  console.log(`[Finalizer] Object associated with '${heldValue}' was garbage collected.`);
});

function allocateTemporaryBuffer() {
  let targetObject: { id: string } | null = { id: "session-12345" };

  // Register targetObject. Pass 'heldValue' (primitive/metadata) to identify it later.
  registry.register(targetObject, "session-12345");

  // When targetObject goes out of scope and is collected by GC,
  // the registry callback will eventually fire with "session-12345".
}
```

---

## 3. Valid Use Cases vs Anti-Patterns

### ✅ Valid Use Cases
1. **Memory-Sensitive Secondary Caches**: Caching computed responses or image buffers where cache eviction via GC is acceptable if memory pressure increases.
2. **Weak Maps/Sets with Non-Object Keys**: Mapping metadata without keeping objects alive manually.
3. **Internal Engine / Native Addon Tracking**: C++ bindings monitoring JS object life cycles.

### ❌ Anti-Patterns (Golden Rule: Never Use for Correctness)

1. **Closing External Resources (DB Connections, File Descriptors)**:
   - **Why it breaks**: V8 GC runs non-deterministically. If GC does not trigger for 10 minutes, file descriptors or DB connections remain leaked on the OS side.
   - **Correct approach**: Use `try...finally`, `using` explicit resource management (TC39 Explicit Resource Management), or explicit `.close()` / `.dispose()` methods.

2. **Expecting Immediate Execution**:
   - Finalizer callbacks are queued as microtasks/macrotasks *after* GC completes. If the Node.js process exits, finalizers may never run at all.

---

## 4. Code Comparison: Explicit Disposal vs Finalizer

```typescript
// ❌ WRONG: Relying on FinalizationRegistry to clean up external files
const fileRegistry = new FinalizationRegistry((fd: number) => {
  // Dangerous! Might never execute before process exits or OS runs out of FDs
  fs.closeSync(fd);
});

// ✅ CORRECT: Explicit deterministic cleanup
class FileHandler implements Disposable {
  constructor(private fd: number) {}

  [Symbol.dispose]() {
    // Guaranteed to execute immediately when scope finishes
    fs.closeSync(this.fd);
  }
}
```
