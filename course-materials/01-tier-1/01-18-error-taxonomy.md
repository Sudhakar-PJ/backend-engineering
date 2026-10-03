# Error Taxonomy

## 1. 💡 Intuition & ELI5 Analogy

Imagine managing a package delivery fleet.

- **Programmer Errors (Bugs)**: A delivery truck was built with no steering wheel (`TypeError: cannot read property of undefined`). Retrying the delivery won't fix it — the truck must be taken to the repair shop immediately.
- **Operational Errors (Expected Runtime Failures)**: A delivery address doesn't exist, or a highway bridge is temporarily closed due to high winds (`404 Not Found`, `ETIMEDOUT`). The truck driver checks their route map, waits 5 minutes, or returns the package with a clear status report.
- **Transient vs Terminal Operational Errors**:
  - *Transient*: Temporary packet loss or a database connection pool timeout. Safe to retry with exponential backoff.
  - *Terminal*: Invalid JSON payload or bad password. Retrying 100 times will fail 100 times and waste network bandwidth.

In backend engineering, treating all errors identical leads to either: (1) crashing the server on expected invalid user input, or (2) retrying invalid HTTP 400 requests endlessly until external services rate-limit your platform.

```typescript
// ❌ Naive / Broken Code: Retrying all errors indiscriminately
async function fetchUserData(userId: string) {
  for (let i = 0; i < 5; i++) {
    try {
      return await apiCall(`/users/${userId}`);
    } catch (err) {
      // ⚠️ DANGER: If err is a 404 Not Found or a 400 Bad Request, retrying 5 times 
      // wastes time and network resources on a guaranteed failure!
      console.log(`Retry attempt ${i + 1}...`);
    }
  }
}
```

---

## 2. 🔬 Deep Architectural Breakdown & Engine Mechanics

### The Two-Dimensional Error Classification Matrix

To build reliable backend systems, every error must be classified along two independent axes:

#### Axis 1: Operational vs. Programmer

| Category | Definition | Example | Recovery Action |
|---|---|---|---|
| **Operational** | Expected runtime environment failures. Correct code handling imperfect real-world conditions. | DB connection drop, invalid JSON, API timeout, 404 | Catch, map to HTTP status code, log warning, retry if transient |
| **Programmer** | Bugs in developer code logic or invalid invariant assertions. | `TypeError`, `RangeError`, accessing `null.x`, bad array index | Fail fast, log fatal, crash process safely, release hotfix |

#### Axis 2: Transient vs. Terminal

| Category | Definition | Example | Retry Strategy |
|---|---|---|---|
| **Transient** | Temporary infrastructure glitch expected to self-heal shortly. | DB pool socket timeout (`ECONNRESET`), HTTP `429`, HTTP `503` | Retry with Exponential Backoff + Jitter |
| **Terminal** | Permanent failure condition. Will never succeed without payload changes. | Invalid API key (`401`), missing record (`404`), schema validation failure (`420`) | Do NOT retry. Fail immediately and alert caller. |

```
                       ┌───────────────────────────────┐
                       │       Incoming Error          │
                       └───────────────┬───────────────┘
                                       │
                    Is it a code bug or runtime event?
                                       │
                   ┌───────────────────┴───────────────────┐
                   ▼                                       ▼
          [ Programmer Error ]                   [ Operational Error ]
       (TypeError, NullPointer)                  (Network, DB, Validation)
                   │                                       │
             LOG FATAL &                              Is it retryable?
            CRASH PROCESS                        ┌─────────┴─────────┐
                                                 ▼                   ▼
                                           [ Transient ]        [ Terminal ]
                                           (Timeout, 503)       (400, 404, 401)
                                                 │                   │
                                            Retry with          Fail Fast &
                                              Backoff           Return Status
```

---

## 3. 💻 Complete Production Code + Line-by-Line Annotations

Below is a production-grade Error Classifier & Retry Handler that evaluates error taxonomy before attempting recovery.

```typescript
import { AppBaseError } from "./01-17-custom-error-classes.js";

export enum ErrorCategory {
  PROGRAMMER_BUG = "PROGRAMMER_BUG",
  OPERATIONAL_TRANSIENT = "OPERATIONAL_TRANSIENT",
  OPERATIONAL_TERMINAL = "OPERATIONAL_TERMINAL",
}

export interface ErrorAnalysis {
  category: ErrorCategory;
  isRetryable: boolean;
  suggestedStatusCode: number;
}

/**
 * Evaluates an arbitrary caught error and classifies it according to backend taxonomy rules.
 */
export function classifyError(err: unknown): ErrorAnalysis {
  // Line Annotation 1: Standardize non-Error objects into formal Error instances
  const error = err instanceof Error ? err : new Error(String(err));

  // Line Annotation 2: Detect native V8 programmer/language bugs
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  ) {
    return {
      category: ErrorCategory.PROGRAMMER_BUG,
      isRetryable: false,
      suggestedStatusCode: 500,
    };
  }

  // Line Annotation 3: Check network socket transient error codes
  const code = (error as any).code;
  const transientSocketCodes = ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED"];
  if (code && transientSocketCodes.includes(code)) {
    return {
      category: ErrorCategory.OPERATIONAL_TRANSIENT,
      isRetryable: true,
      suggestedStatusCode: 503,
    };
  }

  // Line Annotation 4: Evaluate domain operational errors via HTTP status codes
  if (error instanceof AppBaseError) {
    const is5xx = error.statusCode >= 500 && error.statusCode < 600;
    return {
      category: is5xx ? ErrorCategory.OPERATIONAL_TRANSIENT : ErrorCategory.OPERATIONAL_TERMINAL,
      isRetryable: is5xx,
      suggestedStatusCode: error.statusCode,
    };
  }

  // Fallback for unclassified operational errors
  return {
    category: ErrorCategory.OPERATIONAL_TERMINAL,
    isRetryable: false,
    suggestedStatusCode: 500,
  };
}

/**
 * Executes an async operation with intelligent backoff, retrying ONLY transient operational errors.
 */
export async function executeWithTaxonomyRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 100
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt++;
      const analysis = classifyError(err);

      // Line Annotation 5: Immediately rethrow if error is terminal or a programmer bug
      if (!analysis.isRetryable || attempt > maxRetries) {
        throw err;
      }

      // Exponential backoff with randomized jitter to prevent thundering herd
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 50;
      console.warn(`[Taxonomy Retry] Transient error encountered. Attempt ${attempt}/${maxRetries}. Retrying in ${Math.round(delay)}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
```

---

## 4. ⚠️ Real-World Failure Modes & Security Edge Cases

1. **Thundering Herd Problem from Retrying Without Jitter**:
   - When a database restarts, 1,000 backend worker processes fail simultaneously with `ECONNREFUSED`. If all 1,000 workers retry at exact 1.0s, 2.0s, and 4.0s intervals without random jitter, the incoming request spikes collapse the database server as soon as it attempts to boot.
2. **Retrying Non-Idempotent Operations**:
   - Retrying a transient network timeout on a `POST /payments/charge` request where the remote server processed the charge but dropped the response socket. Retrying causes double-charging!
   - **Rule**: Retries are only safe for idempotent operations (e.g. `GET`, `PUT`, `DELETE`) or operations guarded by an Idempotency-Key header.
3. **Catching Programmer Errors as Operational**:
   - Wrapping a block containing a logic typo (`user.addres.street`) in a `try...catch` that treats all errors as 400 Bad Request. The developer bug is masked and returned to API consumers as client error.

---

## 5. 🛠️ Hands-On Guided Exercise & Reference Solution

### Exercise

Write a function `isTransientDatabaseError(err: unknown): boolean` that returns `true` if:
1. The error code is Postgres transient lock/connection error (`40001` Serialization Failure, `40P01` Deadlock Detected, or `57P01` Admin Shutdown).
2. The error message contains `"connection timeout"` or `"deadlock detected"`.
3. Returns `false` for all schema violations (`23505` Unique Violation, `23503` Foreign Key Violation).

### Reference Solution

```typescript
export function isTransientDatabaseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  const code = (err as any).code;
  const message = String((err as any).message ?? "").toLowerCase();

  // Postgres Transient SQLSTATE Error Codes
  const transientSqlCodes = ["40001", "40P01", "57P01", "57P03"];
  if (typeof code === "string" && transientSqlCodes.includes(code)) {
    return true;
  }

  // Common transient DB error messages
  if (message.includes("connection timeout") || message.includes("deadlock detected") || message.includes("econnreset")) {
    return true;
  }

  return false;
}
```
