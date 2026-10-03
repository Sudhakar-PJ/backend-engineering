# Heap Snapshots & Heap Limits

> **Mode**: USE | **Anchor**: T1-CLI | **Artifact**: `heap-snapshot-demo/` | **Ref**: T6

---

## 1. 💡 Intuition

When a Node.js process experiences gradual memory growth in production, guessing which variables or closures are holding memory is impossible. **Heap Snapshots** are full point-in-time point-and-graph dumps of every V8 object, string, closure, and pointer reference currently residing on the JS heap.

You reach for heap profiling tools when:
1. RSS or Heap Used metrics show a steady upward trend despite low active traffic.
2. A container crashes repeatedly with Kubernetes `OOMKilled` (Exit Code 137).
3. You need to verify whether a fix actually freed retained objects after a GC run.

---

## 2. 💻 Usage in the Project

In Node.js applications, heap profiling can be triggered programmatically using built-in modules (`node:v8`), CLI flags (`--max-old-space-size`, `--heapsnapshot-signal`), or remotely via Chrome DevTools (`--inspect`).

### Programmatic Snapshot Generation (`node:v8`)

```typescript
import v8 from "node:v8";
import path from "node:path";
import fs from "node:fs";

/**
 * Takes a heap snapshot and writes it to disk.
 * Can be triggered via HTTP admin endpoint or signal handler.
 */
export function takeHeapSnapshot(filenamePrefix = "snapshot"): string {
  const dir = path.join(process.cwd(), "snapshots");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const filePath = path.join(dir, `${filenamePrefix}-${Date.now()}.heapsnapshot`);
  
  // v8.getHeapSnapshot() returns a Readable stream representing the JSON snapshot graph
  const snapshotStream = v8.getHeapSnapshot();
  const writeStream = fs.createWriteStream(filePath);

  snapshotStream.pipe(writeStream);
  
  console.log(`[Heap Profiler] Written heap snapshot to ${filePath}`);
  return filePath;
}
```

### Inspecting in Chrome DevTools
1. Take two snapshots: **Snapshot 1** (baseline after server startup) and **Snapshot 2** (after running traffic / workload).
2. Load both `.heapsnapshot` files into **Chrome DevTools -> Memory panel**.
3. Select **Snapshot 2**, switch perspective view from *Summary* to **Comparison**, and compare against Snapshot 1.
4. Sort by `# Delta` or `Size Delta` to instantly spot objects created during traffic that failed to be garbage collected.

---

## 3. ⚠️ Failure Modes & Traps

1. **Taking Snapshots Too Late**:
   - If you trigger a snapshot after an `OOMKill` or right when process memory hits 100%, the process may freeze, crash, or fail to write the multi-hundred megabyte `.heapsnapshot` file to disk.
   - **Fix**: Set up heap threshold warnings (e.g., at 75% heap usage) to automatically trigger snapshots *before* total exhaustion.

2. **Snapshot Allocation Overhead**:
   - Generating a heap snapshot freezes the event loop and requires additional memory to build the snapshot graph. On an 8GB heap, generating a snapshot can temporarily require 1-2GB of additional RAM and pause execution for several seconds.

3. **Confusing Shallow Size vs Retained Size**:
   - **Shallow Size**: The byte size of the object itself (e.g., a `Map` header structure is only ~32 bytes).
   - **Retained Size**: The total memory freed if this object and its children were deleted. Always inspect **Retained Size** when hunting leaks!
