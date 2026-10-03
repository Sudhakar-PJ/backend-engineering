# Stack Traces & Error Context

## 1. 💡 Intuition & ELI5 Analogy

Imagine detective work solving a crime.

- **Lost Context (Discarding the Original Error)**: Detective finds a broken window and files a report saying "Property Damaged." They throw away the intruder's fingerprints and footprint evidence. When the captain asks *how* it happened, nobody knows.
- **Cause Chains (`new Error("Operation failed", { cause: originalError })`)**: Detective files a master case file ("Property Damaged") and attaches the original evidence bag ("Intruder Window Breach") inside it. The supervisor can open the outer file and trace back every prior event frame to the exact root cause.

In Node.js backend engineering, catching a low-level error (e.g., Postgres `ECONNREFUSED`) and re-throwing a generic `new Error("Failed to process payment")` without preserving the original error discards the file line number and socket reason, making root-cause debugging in production impossible.

```typescript
// ❌ Naive / Broken Code: Discarding the root cause error
async function getUserProfile(userId: string) {
  try {
    return await db.query("SELECT * FROM users WHERE id = $1", [userId]);
  } catch (err) {
    // ⚠️ DANGER: Original 'err' object is discarded! Stack trace and DB error code are LOST forever!
    throw new Error(`Failed to load profile for user ${userId}`);
  }
}
```

---

## 2. 🔬 Deep Architectural Breakdown & Engine Mechanics

### V8 Stack Trace Generation & `Error.stackTraceLimit`

1. **Stack Frame Formatting (`Error.prepareStackTrace`)**:
   - V8 formats `.stack` lazily when the `.stack` property is accessed for the first time.
   - Default depth is `10` frames (`Error.stackTraceLimit = 10`). In deeply nested async frameworks (Express, Prisma, RxJS), 10 frames often fail to reach the application code that triggered the call!
2. **ES2022 `Error.cause` Standardization**:
   - The native `Error` constructor accepts `{ cause: err }`.
   - Accessing `err.cause` returns the nested underlying error.
3. **Async Stack Traces**:
   - V8 stitches stack frames across `await` boundaries using microtask task tracking.
   - Synchronous callback boundaries (`setTimeout`, EventEmitter callbacks) break the call stack unless explicitly chained with cause objects.

```
       Outer Domain Error: PaymentProcessingError
       ├── message: "Failed to charge customer card"
       ├── stack: [UserRepository.ts:42 -> PaymentService.ts:18]
       └── cause: Inner Infrastructure Error: StripeNetworkError
            ├── message: "API connection timed out after 5000ms"
            ├── stack: [StripeClient.ts:91 -> http.ts:104]
            └── cause: Low-Level Engine Error: SystemError
                 └── code: "ETIMEDOUT"
```

---

## 3. 💻 Complete Production Code + Line-by-Line Annotations

Below is a production cause-chain serializer and error context wrapper.

```typescript
export interface EnrichedErrorMetadata {
  requestId?: string;
  userId?: string;
  operationName?: string;
  [key: string]: unknown;
}

export class ContextualError extends Error {
  public readonly metadata: EnrichedErrorMetadata;

  constructor(
    message: string,
    metadata: EnrichedErrorMetadata = {},
    cause?: Error
  ) {
    // Line Annotation 1: Standard ES2022 cause chaining passed to native Error super
    super(message, { cause });
    this.name = this.constructor.name;
    this.metadata = metadata;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Traverses and formats a complete nested cause chain for structured logging output.
 */
export function formatErrorCauseChain(err: unknown): Array<{
  name: string;
  message: string;
  stack?: string;
  metadata?: EnrichedErrorMetadata;
}> {
  const chain: Array<{
    name: string;
    message: string;
    stack?: string;
    metadata?: EnrichedErrorMetadata;
  }> = [];

  let current: unknown = err;
  const visited = new Set<unknown>();

  while (current && !visited.has(current)) {
    visited.add(current);

    if (current instanceof Error) {
      chain.push({
        name: current.name,
        message: current.message,
        stack: current.stack,
        metadata: (current as ContextualError).metadata,
      });
      // Line Annotation 2: Advance to nested cause object if present
      current = current.cause;
    } else {
      chain.push({
        name: "NonErrorPrimitive",
        message: String(current),
      });
      break;
    }
  }

  return chain;
}

// Line Annotation 3: Increase default V8 stack trace limit for production debugging
Error.stackTraceLimit = 25;
```

---

## 4. ⚠️ Real-World Failure Modes & Security Edge Cases

1. **Truncated Stack Traces via Default `stackTraceLimit`**:
   - V8 defaults to 10 frames. In heavily modularized code, 8 frames are taken by framework internal code, leaving only 2 frames of user code and truncating the actual function call site.
   - **Fix**: Set `Error.stackTraceLimit = 25` or `50` at app startup.
2. **Cyclic Cause Object References**:
   - If a custom error inadvertently sets `err.cause = err` (self-reference) or forms a cycle (`A -> B -> A`), naive log formatting loops run infinitely until call stack overflow occurs.
   - **Fix**: Use a `Set` to track visited error instances during cause chain traversal.
3. **Throwing Non-Error Primitives (`throw "string"` or `throw 404`)**:
   - JavaScript allows throwing strings, numbers, or plain objects. When caught, `err.stack` is `undefined`, destroying call context entirely.
   - **Fix**: Always normalize caught errors with `const error = err instanceof Error ? err : new Error(String(err))`.

---

## 5. 🛠️ Hands-On Guided Exercise & Reference Solution

### Exercise

Write a helper function `wrapAsyncWithContext<T>(operationName: string, metadata: EnrichedErrorMetadata, fn: () => Promise<T>): Promise<T>` that:
1. Executes `fn()`.
2. If `fn()` throws or rejects, catches the error and wraps it in a `ContextualError` containing `operationName`, `metadata`, and the original error attached as `cause`.
3. Preserves the original stack trace details.

### Reference Solution

```typescript
import { ContextualError, EnrichedErrorMetadata } from "./ContextualError";

export async function wrapAsyncWithContext<T>(
  operationName: string,
  metadata: EnrichedErrorMetadata,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new ContextualError(
      `Operation '${operationName}' failed: ${cause.message}`,
      { ...metadata, operationName },
      cause
    );
  }
}
```
