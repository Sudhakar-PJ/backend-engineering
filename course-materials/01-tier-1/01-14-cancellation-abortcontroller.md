# Cancellation with AbortController / AbortSignal

## 1. 💡 Intuition & ELI5 Analogy

Imagine ordering a multi-course dinner at a restaurant, but halfway through you receive an emergency phone call and need to leave immediately.

- **Without Cancellation**: The kitchen keeps cooking all your remaining courses, your waiter brings them to your empty table, and you get billed for food you never ate, wasting kitchen capacity and ingredients.
- **With `AbortController`**: You signal your waiter ("Abort!"), who immediately notifies the kitchen. The kitchen stops chopping, cancels pending orders, frees up stove space for other guests, and cleans up your table.

In Node.js backend engineering, an HTTP client disconnecting, a request timing out, or a pipeline shutdown requires stopping pending database queries, HTTP requests, timers, and background tasks immediately to avoid resource leakage and wasted computation.

```typescript
// ❌ Naive / Broken Code: Uncancellable Async Fetch Loop
async function pollExternalApi(url: string) {
  while (true) {
    // ⚠️ DANGER: If the client disconnects or the service shuts down, 
    // this request cannot be cancelled! It runs to completion, consuming CPU, sockets, and memory.
    const res = await fetch(url);
    const data = await res.json();
    console.log("Polled data:", data);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
```

---

## 2. 🔬 Deep Architectural Breakdown & Engine Mechanics

### `AbortController` & `AbortSignal` Core Architecture

`AbortController` is a standardized web API integrated deeply into Node.js (v15+) and the browser standard runtime. It consists of two objects:

1. **`AbortController`**: The command controller that triggers cancellation by calling `controller.abort(reason?)`.
2. **`AbortSignal`**: An `EventTarget` instance passed down to consumers (e.g., `fetch`, `fs.readFile`, DB drivers, custom async functions). It exposes:
   - `signal.aborted`: A boolean flag indicating if `abort()` was called.
   - `signal.reason`: The error/reason provided when aborted (defaults to `DOMException("This operation was aborted", "AbortError")` or a standard `Error`).
   - `'abort'` event: Emitted on the signal when `controller.abort()` is executed.

```
       [ Producer / Caller ]
                 │
        creates AbortController
                 │
       ┌─────────┴─────────┐
       │                   │
  holds & calls      passes signal down
  controller.abort()       │
       │                   ▼
       │         [ Consumer Async Task ]
       │         (e.g., fetch, DB, Stream)
       │                   │
       └───── fires ───────┤
         'abort' event /   │ throws AbortError
         signal.aborted    ▼
```

### Event Listener Memory Management & `signal.throwIfAborted()`

When integrating `AbortSignal` into custom async primitives, registering event listeners via `signal.addEventListener('abort', fn)` introduces potential memory leaks if the operation completes successfully *without* being aborted.

- **Engine Guarantee**: Always unregister the `'abort'` event listener (`signal.removeEventListener`) in a `finally` block or use helper utilities like `AbortSignal.any()` or `events.on(signal, 'abort')`.
- **`signal.throwIfAborted()`**: Synchronously checks `signal.aborted` and throws `signal.reason` immediately if already aborted. Call this at entry points and key iteration boundaries to prevent starting expensive work on an already-canceled task.

---

## 3. 💻 Complete Production Code + Line-by-Line Annotations

Below is a production-grade cancellable async worker wrapper with timeout support, cleanup, and child signal propagation.

```typescript
import { AbortController, AbortSignal } from "node:events";

interface CancellableOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Creates a combined AbortSignal from an optional parent signal and optional timeout.
 * Demonstrates AbortSignal.any() and timeout teardown mechanics.
 */
export function createCombinedSignal(options: CancellableOptions = {}): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const cleanupFns: Array<() => void> = [];

  // 1. Use AbortSignal.any() if available (Node 20+) to compose signals cleanly
  if (options.signal && options.timeoutMs) {
    const combinedSignal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(options.timeoutMs),
    ]);
    return { signal: combinedSignal, cleanup: () => {} };
  }

  // Fallback / manual composition for robust signal chaining:
  const controller = new AbortController();

  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      const onParentAbort = () => controller.abort(options.signal!.reason);
      options.signal.addEventListener("abort", onParentAbort, { once: true });
      cleanupFns.push(() => options.signal?.removeEventListener("abort", onParentAbort));
    }
  }

  let timerId: NodeJS.Timeout | null = null;
  if (options.timeoutMs !== undefined) {
    timerId = setTimeout(() => {
      controller.abort(new Error(`Operation timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    cleanupFns.push(() => {
      if (timerId) clearTimeout(timerId);
    });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const fn of cleanupFns) fn();
    },
  };
}

/**
 * Cancellable async task simulator that honors AbortSignal during sleep and work phases.
 */
export async function cancellableAsyncTask(
  workDurationMs: number,
  signal?: AbortSignal
): Promise<string> {
  // Line Annotation 1: Fail early if signal is already aborted before starting
  signal?.throwIfAborted();

  return new Promise<string>((resolve, reject) => {
    let timer: NodeJS.Timeout;

    // Line Annotation 2: Define abort listener that rejects promise immediately
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Task aborted"));
    };

    // Line Annotation 3: Register abort handler with { once: true }
    signal?.addEventListener("abort", onAbort, { once: true });

    timer = setTimeout(() => {
      // Line Annotation 4: Clean up event listener on successful completion to avoid memory leaks
      signal?.removeEventListener("abort", onAbort);
      resolve(`Completed work in ${workDurationMs}ms`);
    }, workDurationMs);
  });
}
```

---

## 4. ⚠️ Real-World Failure Modes & Security Edge Cases

1. **Memory Leak from Unremoved Abort Listeners**:
   - Registering `signal.addEventListener('abort', ...)` without removing it on success keeps callback closures references in memory attached to the long-lived `AbortSignal`. In HTTP servers handling millions of requests, this causes rapid heap exhaustion.
2. **Orphaned Database Queries / Downstream Socket Leaks**:
   - Omitting `signal` when calling database queries (e.g., `pg`, `prisma`, `knex`) or downstream HTTP requests (`fetch(url, { signal })`). When a client disconnects, Express/Fastify aborts `req.signal`, but the database query continues running on the Postgres server, burning CPU and locking rows needlessly.
3. **Ignoring `signal.aborted` in Multi-Step Pipelines**:
   - In long-running pipelines (e.g. processing 10,000 batches), only checking `signal` at the beginning means a cancellation requested at item 2 forces the worker to run items 3 through 10,000 before returning. Call `signal.throwIfAborted()` inside loop iterations.
4. **Swallowing Abort Errors as Fatal Failures**:
   - Misclassifying `AbortError` as an unhandled server error and logging severe `500 Internal Server Error` alarms when a client simply navigated away or canceled an autocomplete request.

---

## 5. 🛠️ Hands-On Guided Exercise & Reference Solution

### Exercise

Write a function `cancellableFetchWithRetry(url: string, retries: number, delayMs: number, signal?: AbortSignal)` that:
1. Performs `fetch(url, { signal })`.
2. If fetch fails due to network error and NOT cancellation, retries up to `retries` times, waiting `delayMs` between retries.
3. If `signal` is aborted at ANY point (before start, during fetch, or during delay between retries), immediately stops retrying and throws the abort reason.

### Reference Solution

```typescript
export async function cancellableFetchWithRetry(
  url: string,
  retries: number,
  delayMs: number,
  signal?: AbortSignal
): Promise<Response> {
  let attempt = 0;

  while (true) {
    // Check if already aborted before attempting
    signal?.throwIfAborted();

    try {
      return await fetch(url, { signal });
    } catch (err: any) {
      attempt++;
      // If aborted, fetch throws AbortError (or signal.reason) - rethrow immediately
      if (signal?.aborted || err.name === "AbortError") {
        throw signal?.reason ?? err;
      }

      if (attempt > retries) {
        throw err;
      }

      // Cancellable sleep delay between retries
      await new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();

        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delayMs);

        const onAbort = () => {
          clearTimeout(timer);
          reject(signal?.reason ?? new Error("Aborted during retry delay"));
        };

        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
```
