# Sync vs Async Error Propagation

## 1. 💡 Intuition & ELI5 Analogy

Imagine passing a fragile physical box down an assembly line of factory workers.

- **Synchronous Error Propagation (`throw` / `try...catch`)**: Worker A tries to process the box immediately. If it snaps, Worker A immediately yells to Worker B standing right next to them on the synchronous call stack.
- **Async Callback Error Propagation (`cb(err, data)`)**: Worker A drops the box into a chute to be processed by a night-shift worker later. If the box breaks at night, the night-shift worker cannot yell back up the stack (which no longer exists!). They must place a bug report on the next day's desk (`cb(err)`).
- **Async Promise / Event Error Propagation**: Worker A sends the box via pneumatic tube. If it breaks, a red alarm lights up on the destination tube terminal (`.catch()` / EventEmitter `'error'`). If no alarm listener is wired up, the red alarm buzzes indefinitely until the whole factory power trips (unhandled rejection).

```typescript
// ❌ Naive / Broken Code: Losing Async Errors Across Async Boundaries
function unsafeAsyncOperation(callback: (data: string) => void) {
  setTimeout(() => {
    // ⚠️ DANGER: Throwing synchronously inside an async timer/callback!
    // This try...catch around unsafeAsyncOperation CANNOT catch this error 
    // because the outer stack has already finished executing!
    throw new Error("Failed inside async callback");
  }, 100);
}

try {
  unsafeAsyncOperation((data) => console.log(data));
} catch (err) {
  // Never reaches here! Process crashes with uncaughtException.
  console.error("Caught error:", err);
}
```

---

## 2. 🔬 Deep Architectural Breakdown & Engine Mechanics

### The Four Async Error Channels in Node.js

Node.js has evolved four distinct paradigms for error propagation, each with unique stack trace and engine mechanics:

1. **Synchronous Call Stack (`throw / try...catch`)**:
   - Errors propagate back up the active Execution Context Call Stack frames.
   - Preserves synchronous stack trace.

2. **Error-First Callbacks (`(err, result) => void`)**:
   - Pre-Promise convention used across legacy Node APIs (`fs.readFile`).
   - The first argument is reserved for an `Error` instance (or `null` if successful).
   - **Crucial Warning**: Errors thrown *inside* callback implementations bypass the caller's `try...catch` unless explicitly caught within the callback.

3. **Promise / `async-await` Rejections (`reject(err)` / `throw` in `async`)**:
   - Rejections travel down the Promise reaction job queue.
   - `async` functions automatically wrap return values in `Promise.resolve` and thrown errors in `Promise.reject`.
   - Stack traces are captured at the point of `new Error()` and stitched across async tick boundaries via V8 async stack traces (`AsyncStackTrace`).

4. **Event Emitter Error Events (`emitter.emit('error', err)`)**:
   - Standard event channels (`stream`, `net`, `http`).
   - **Node Guarantee**: If an `EventEmitter` emits an `'error'` event and **no listener** is registered for `'error'`, Node.js treats it as an unhandled exception and crashes the process.

```
                  ┌─────────────────────────────┐
                  │ Synchronous Execution Frame │
                  └──────────────┬──────────────┘
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
   Sync Stack Frame                           Async Task Scheduled
   [ try...catch block ]                       (Timer/I/O/Microtask)
         │                                               │
         ▼                                               ▼
   Catches `throw`                             Original stack frame exited!
                                                         │
                                    ┌────────────────────┴────────────────────┐
                                    ▼                                         ▼
                             Promise Rejection                     EventEmitter 'error'
                           (.catch / await try)                 (emitter.on('error'))
```

---

## 3. 💻 Complete Production Code + Line-by-Line Annotations

Below is a production pattern illustrating safe cross-boundary error propagation across callbacks, Promises, and EventEmitters.

```typescript
import { EventEmitter } from "node:events";

interface TaskResult {
  id: string;
  processedAt: Date;
}

export class SafeTaskPipeline extends EventEmitter {
  /**
   * Converts a legacy error-first callback API into a Promise-based method,
   * guaranteeing that errors are safely caught and re-directed to the Promise rejection channel.
   */
  public async executeCallbackTask(taskId: string): Promise<TaskResult> {
    return new Promise<TaskResult>((resolve, reject) => {
      this.legacyCallbackOperation(taskId, (err, data) => {
        // Line Annotation 1: Check for error in callback channel and propagate to Promise reject
        if (err) {
          return reject(err);
        }
        if (!data) {
          return reject(new Error("Callback returned empty data without error"));
        }
        resolve(data);
      });
    });
  }

  /**
   * Simulates legacy node callback operation with try...catch around async body.
   */
  private legacyCallbackOperation(
    taskId: string,
    callback: (err: Error | null, result?: TaskResult) => void
  ): void {
    setTimeout(() => {
      // Line Annotation 2: Wrap internal callback logic in try...catch to prevent uncaught async throws
      try {
        if (taskId === "invalid") {
          throw new Error(`Invalid task ID provided: ${taskId}`);
        }
        callback(null, { id: taskId, processedAt: new Date() });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        // Line Annotation 3: Pass thrown error safely into callback error slot
        callback(error);
      }
    }, 50);
  }

  /**
   * Safe EventEmitter emitter that guards against crashing if no 'error' listener is present.
   */
  public safeEmitError(err: Error): void {
    // Line Annotation 4: Check if 'error' listeners exist before emitting to prevent unhandled crash
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);
    } else {
      console.warn("[SafePipeline Warning]: Suppressed unhandled EventEmitter error:", err.message);
    }
  }
}
```

---

## 4. ⚠️ Real-World Failure Modes & Security Edge Cases

1. **Mixing `async` and Sync Callbacks Without Catching**:
   - Passing an `async` function as a callback into a library expecting a synchronous callback (e.g. `array.forEach(async (item) => ...)`). Any rejection thrown inside the async callback is unhandled because `forEach` ignores the returned Promise!
2. **Missing `'error'` Listener on Streams / EventEmitters**:
   - Creating a `fs.createReadStream()` or custom `EventEmitter` without attaching `.on('error', cb)`. If the file doesn't exist or disk fails, Node throws an unhandled exception, abruptly crashing the backend service.
3. **Double Callbacks in Async Error Branches**:
   - Forgetting to `return` when calling `callback(err)`, causing execution to continue down into `callback(null, data)`. The callback executes twice, producing duplicate HTTP responses or corrupted state.
4. **Floating Un-awaited Promises**:
   - Calling an `async` background operation inside an HTTP handler without `await` or `.catch()` (e.g. `saveMetricsAsync()`). When `saveMetricsAsync()` rejects, it becomes an unhandled rejection, bypassing Express error middleware.

---

## 5. 🛠️ Hands-On Guided Exercise & Reference Solution

### Exercise

Write a utility function `promisifyStream(emitter: EventEmitter): Promise<void>` that:
1. Resolves when the emitter emits `'finish'` or `'end'`.
2. Rejects when the emitter emits `'error'`.
3. Ensures all event listeners are cleanly unhooked (`removeListener`) when either event fires, preventing memory listener leaks.

### Reference Solution

```typescript
import { EventEmitter } from "node:events";

export function promisifyStream(emitter: EventEmitter): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      emitter.removeListener("finish", onFinish);
      emitter.removeListener("end", onFinish);
      emitter.removeListener("error", onError);
    };

    const onFinish = () => {
      cleanup();
      resolve();
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    emitter.on("finish", onFinish);
    emitter.on("end", onFinish);
    emitter.on("error", onError);
  });
}
```
