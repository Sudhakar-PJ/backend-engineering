# Custom Error Classes

## 1. 💡 Intuition & ELI5 Analogy

Imagine a hospital emergency room intake desk.

- **Generic `Error`**: A patient walks in and says "I feel bad." The triage nurse doesn't know whether to send them to surgery, cardiology, or home with aspirin, because there's no structured diagnostic metadata or classification.
- **Custom Error Classes (`ValidationError`, `DatabaseTimeoutError`, `UnauthorizedError`)**: Patients arrive wearing color-coded wristbands containing standardized fields: Blood Type, Triage Level, Department Code, and Root Cause. The nurse routes them instantly to the exact right treatment workflow without guessing.

In Node.js backend engineering, throwing raw `new Error("invalid input")` forces HTTP handlers and error middleware to parse error string messages with regex to determine whether to return a 400, 401, 404, or 500 status code. Custom error classes make errors strongly-typed domain objects with structured status codes and metadata.

```typescript
// ❌ Naive / Broken Code: String-matching generic Error instances
function handleRequest(err: Error) {
  // ⚠️ DANGER: Fragile string parsing! If the wording of the error message changes, 
  // this error handler breaks, silently returning 500 instead of 400!
  if (err.message.includes("not found")) {
    return { status: 404, body: err.message };
  }
  return { status: 500, body: "Internal Server Error" };
}
```

---

## 2. 🔬 Deep Architectural Breakdown & Engine Mechanics

### Prototype Chain & `Error.captureStackTrace` Mechanics

When extending the native V8 `Error` class in TypeScript/JavaScript, several low-level engine mechanics must be satisfied:

1. **`super(message)`**: Calls the parent `Error` constructor to set `this.message` and establish internal V8 error slots.
2. **`this.name`**: Native `Error` instances have `name = 'Error'`. Derived custom errors MUST set `this.name = this.constructor.name` (or an explicit class name string) so loggers and serializers output the correct type label.
3. **`Error.captureStackTrace(this, TargetConstructor)`**:
   - V8-specific API. Omitting this includes the custom error constructor call itself at the top of the stack trace.
   - Passing `this` and `TargetConstructor` trims the constructor execution frames from the top of `.stack`, keeping the stack trace clean and pointing directly to the caller line where the error was thrown.
4. **`Error.cause`**: Standardized ES2022 property for error chaining. Allows wrapping low-level errors (e.g. Postgres `ECONNREFUSED`) inside higher-level domain errors (`DatabaseConnectionError`) without losing original diagnostic context.

```
       Native V8 Error Class
                 │
  ┌──────────────┴──────────────┐
  │  this.message               │
  │  this.stack (captured)      │
  │  this.cause (optional)      │
  └──────────────┬──────────────┘
                 │ extends
                 ▼
       AppBaseError Class (abstract)
                 │  (name, statusCode, isOperational)
  ┌──────────────┴──────────────┐
  │                             │
  ▼                             ▼
ValidationError           NotFoundError
(400 Bad Request)         (404 Not Found)
```

---

## 3. 💻 Complete Production Code + Line-by-Line Annotations

Below is a production-grade hierarchy of custom error classes for backend services.

```typescript
/**
 * Base operational error class from which all application domain errors extend.
 */
export abstract class AppBaseError extends Error {
  public abstract readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly timestamp: string;

  constructor(message: string, cause?: Error) {
    // Line Annotation 1: Pass message to native Error super constructor
    super(message, { cause });

    // Line Annotation 2: Explicitly assign name property to derived class name
    this.name = this.constructor.name;
    this.isOperational = true;
    this.timestamp = new Date().toISOString();

    // Line Annotation 3: Trim constructor frames from stack trace in V8 engine
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * JSON serialization helper for structured logging
   */
  public toJSON() {
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      isOperational: this.isOperational,
      timestamp: this.timestamp,
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
    };
  }
}

/**
 * 400 Bad Request — Thrown when user input validation fails.
 */
export class ValidationError extends AppBaseError {
  public readonly statusCode = 400;

  constructor(
    message: string,
    public readonly details: Record<string, string[]> = {},
    cause?: Error
  ) {
    super(message, cause);
  }
}

/**
 * 404 Not Found — Thrown when requested entity is missing.
 */
export class NotFoundError extends AppBaseError {
  public readonly statusCode = 404;

  constructor(entityName: string, entityId: string | number, cause?: Error) {
    super(`${entityName} with identifier '${entityId}' was not found.`, cause);
  }
}

/**
 * 500 Internal Database Error — Operational wrapper over raw DB driver faults.
 */
export class DatabaseError extends AppBaseError {
  public readonly statusCode = 500;

  constructor(message: string, cause?: Error) {
    super(`Database operation failed: ${message}`, cause);
  }
}
```

---

## 4. ⚠️ Real-World Failure Modes & Security Edge Cases

1. **`instanceof` Breakdown Across Dual Packages / Bundles**:
   - If two npm dependencies load different instances of the same error package, `err instanceof ValidationError` evaluates to `false` even if the error was constructed from a matching class signature!
   - **Fix**: Check `err.name === 'ValidationError'` or a symbol-based indicator in centralized middleware rather than relying purely on `instanceof`.
2. **Leaking Internal DB Stack Traces to External Clients**:
   - Returning `err.message` or `err.stack` directly in HTTP responses for 500 errors reveals database table names, SQL queries, or internal file paths to attackers.
   - **Fix**: Sanitize non-operational or 500 error responses in central error middleware, returning generic `"Internal Server Error"` to clients while logging full details internally.
3. **Forgetting to Call `Error.captureStackTrace`**:
   - Omitting `captureStackTrace` makes every stack trace appear as though it originated inside `super(message)` in `AppBaseError.ts`, masking the actual file and line number where `throw new ValidationError(...)` was executed.
4. **Stripping Prototype Chains in Transpiled ES5 Code**:
   - When TypeScript compiles to ES5, native `Error` subclassing breaks `Object.getPrototypeOf(this)` unless `Object.setPrototypeOf(this, new.target.prototype)` is explicitly called in the constructor.

---

## 5. 🛠️ Hands-On Guided Exercise & Reference Solution

### Exercise

Create an `UnauthorizedError` class (HTTP 401) and a centralized express/fastify-style error handler function `handleError(err: Error)` that:
1. Checks if `err` is operational (`err instanceof AppBaseError` or `err.isOperational === true`).
2. If operational, returns `{ status: err.statusCode, payload: { error: err.name, message: err.message } }`.
3. If non-operational (unknown crash), logs `err.stack` and returns `{ status: 500, payload: { error: "InternalServerError", message: "An unexpected error occurred" } }`.

### Reference Solution

```typescript
import { AppBaseError } from "./AppBaseError";

export class UnauthorizedError extends AppBaseError {
  public readonly statusCode = 401;

  constructor(message: string = "Authentication required", cause?: Error) {
    super(message, cause);
  }
}

export function handleError(err: unknown): { status: number; payload: object } {
  if (err instanceof AppBaseError || (err as any)?.isOperational === true) {
    const operationalErr = err as AppBaseError;
    return {
      status: operationalErr.statusCode,
      payload: {
        error: operationalErr.name,
        message: operationalErr.message,
      },
    };
  }

  // Non-operational or unknown system error (do not leak details!)
  console.error("[CRITICAL UNHANDLED ERROR]:", err);

  return {
    status: 500,
    payload: {
      error: "InternalServerError",
      message: "An unexpected error occurred. Please contact support.",
    },
  };
}
```
