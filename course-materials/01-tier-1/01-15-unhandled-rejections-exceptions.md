# Unhandled Rejection & Uncaught Exception Policy

## 1. 💡 Intuition & ELI5 Analogy

Imagine operating a commercial passenger airplane.

- **Handled Error**: An engine indicator light flickers yellow. The pilot notices, flips a backup switch, and re-routes safely to an emergency landing strip.
- **Unhandled Exception / Rejection**: An unknown severe electrical short occurs. The cockpit instruments shut down entirely, and the flight computer enters an undefined state.
- **Dangerous Bad Habit (Swallowing Exceptions)**: Silencing alarms with tape and keeping the auto-pilot engaged while internal control surfaces are actively burning out.
- **Production Policy (Graceful Crash & Restart)**: The system immediately logs the diagnostic state, stops accepting new flight requests, finishes flushing vital black-box telemetry to ground recording servers, and shuts down so a fresh, clean standby plane (process supervisor / Kubernetes pod) can take over.

In Node.js backend engineering, an unhandled Promise rejection or uncaught sync exception means memory state, variable invariants, or DB connections may be corrupt. Continuing to execute requests in a corrupted process leads to data loss, security vulnerability, and cascading failures.

```typescript
// ❌ Naive / Broken Code: Swallowing process-level errors
process.on("uncaughtException", (err) => {
  // ⚠️ DANGER: Swallowing errors keeps a corrupted process alive!
  // Sockets may leak, DB transactions remain half-committed, and memory state is corrupt.
  console.error("Ignored error:", err);
});
```

---

## 2. 🔬 Deep Architectural Breakdown & Engine Mechanics

### Event Loop Behavior on Unhandled Failures

1. **`uncaughtException`**:
   - Occurs when a synchronous error is thrown and not caught by any `try...catch` block in the call stack.
   - The stack unwinds completely. If no listener exists for `process.on('uncaughtException')`, Node.js prints the stack trace to `stderr` and exits immediately with code `1`.
   - **Crucial Rule**: If you attach a listener to `uncaughtException`, Node.js will *not* default exit. However, running JS after an uncaught exception is unsafe because execution was aborted mid-stream.

2. **`unhandledRejection`**:
   - Occurs when a Promise rejects and no `.catch()` handler or `try...catch` (await) is attached within the microtask turn.
   - Node.js emits `process.on('unhandledRejection')`.
   - **Modern Node Behavior (v15+)**: Unhandled rejections trigger `uncaughtException` if unhandled by default, crashing the process with non-zero exit code (`--unhandled-rejections=throw` is default).

```
   Synchronous Error                Rejected Promise
          │                                │
  unhandled in stack              unhandled microtask
          │                                │
          ▼                                ▼
 process.emit('uncaughtException')  process.emit('unhandledRejection')
          │                                │
 ┌────────┴────────┐              ┌────────┴────────┐
 │ Custom Handler  │              │ Custom Handler  │
 └────────┬────────┘              └────────┬────────┘
          │                                │
          ▼                                ▼
   Flush logs & exit              Log error & terminate
    (Exit Code 1)                   (Exit Code 1)
```

### Process Supervision & Graceful Teardown Sequence

Node.js services rely on process supervisors (PM2, Docker, Kubernetes) for resilience. The application process should **fail fast** and let the orchestrator spawn a clean replacement.

**Production Graceful Teardown Flow:**
1. Intercept `uncaughtException` or `unhandledRejection`.
2. Log the error immediately using structured logging with stack trace & context.
3. Stop receiving new connections (close HTTP server).
4. Allow in-flight requests a grace period (e.g., 5-10 seconds) to complete.
5. Forcefully terminate the process (`process.exit(1)`).

---

## 3. 💻 Complete Production Code + Line-by-Line Annotations

Below is a production-grade Node.js process error handling setup.

```typescript
import http from "node:http";

interface Logger {
  fatal: (obj: object, msg: string) => void;
  info: (msg: string) => void;
}

const mockLogger: Logger = {
  fatal: (obj, msg) => console.error(`[FATAL] ${msg}`, JSON.stringify(obj)),
  info: (msg) => console.log(`[INFO] ${msg}`),
};

export function setupProcessErrorHandler(
  server: http.Server,
  logger: Logger = mockLogger,
  shutdownTimeoutMs: number = 10000
) {
  let isShuttingDown = false;

  const gracefulShutdown = (exitCode: number, error: Error | string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.fatal({ error: String(error) }, "Initiating emergency shutdown due to unhandled process error");

    // Line Annotation 1: Set a hard safety timeout to guarantee process exit even if server hanging
    const forceExitTimer = setTimeout(() => {
      logger.fatal({}, "Forced exit timeout reached. Terminating process immediately.");
      process.exit(exitCode);
    }, shutdownTimeoutMs);

    // Line Annotation 2: Ensure safety timer doesn't prevent Node from exiting naturally if idle
    forceExitTimer.unref();

    // Line Annotation 3: Stop accepting new incoming HTTP connections
    server.close((closeErr) => {
      if (closeErr) {
        logger.fatal({ error: closeErr.message }, "Error during server close");
      }
      logger.info("HTTP server closed successfully. Exiting process.");
      process.exit(exitCode);
    });
  };

  // Line Annotation 4: Handle uncaught synchronous exceptions
  process.on("uncaughtException", (error: Error) => {
    logger.fatal({ stack: error.stack }, "Uncaught Exception detected");
    gracefulShutdown(1, error);
  });

  // Line Annotation 5: Handle unhandled async promise rejections
  process.on("unhandledRejection", (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.fatal({ stack: error.stack }, "Unhandled Rejection detected");
    gracefulShutdown(1, error);
  });
}
```

---

## 4. ⚠️ Real-World Failure Modes & Security Edge Cases

1. **Swallowing Errors via `process.on('uncaughtException', () => {})`**:
   - Keeping a process running after an uncaught exception means state corrupted during execution remains in memory. Database pools, cached user sessions, or locks become permanently invalid.
2. **Missing `unref()` on Shutdown Timeout Timers**:
   - Setting a 30-second fallback timer inside the shutdown handler without calling `.unref()` keeps the event loop active for the full 30 seconds even after all active requests have closed.
3. **Double Shutdown Race Conditions**:
   - Concurrent `uncaughtException` events triggering multiple shutdown routines simultaneously, causing duplicate socket closure errors or duplicate log flushes. Guard with an `isShuttingDown` flag.
4. **Hanging HTTP Server Shutdowns**:
   - Calling `server.close()` without setting HTTP keep-alive header limits or timeout guards allows persistent client connections to keep the server alive forever.

---

## 5. 🛠️ Hands-On Guided Exercise & Reference Solution

### Exercise

Implement a process signal & error manager `registerTerminationHandlers(server: http.Server)` that:
1. Listens for `SIGINT` (Ctrl+C) and `SIGTERM` (container kill signal).
2. Performs a clean graceful shutdown with exit code `0` on signals.
3. Listens for `uncaughtException` and `unhandledRejection` and shuts down with exit code `1`.
4. Ensures duplicate triggers do not execute shutdown twice.

### Reference Solution

```typescript
import http from "node:http";

export function registerTerminationHandlers(server: http.Server): void {
  let isTerminating = false;

  const terminate = (signalOrErr: string | Error, code: number) => {
    if (isTerminating) return;
    isTerminating = true;

    console.log(`[PROCESS] Shutting down. Trigger: ${signalOrErr}`);

    const timeout = setTimeout(() => {
      console.error("[PROCESS] Shutdown timed out. Forcing exit.");
      process.exit(code);
    }, 5000);
    timeout.unref();

    server.close(() => {
      console.log("[PROCESS] Server closed cleanly.");
      process.exit(code);
    });
  };

  process.on("SIGINT", () => terminate("SIGINT", 0));
  process.on("SIGTERM", () => terminate("SIGTERM", 0));

  process.on("uncaughtException", (err) => terminate(err, 1));
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    terminate(err, 1);
  });
}
```
