# Async Iteration & Async Generators

## 1. 💡 Intuition & ELI5 Analogy

Imagine a sushi conveyor belt at a restaurant.

- **Synchronous Iteration (`for...of`)**: All sushi plates are already sitting on the conveyor belt ready to be picked up immediately. You pull plates off the belt one after another without pausing.
- **Async Iteration (`for await...of`)**: The conveyor belt is empty. You sit in front of it and request plates. The chef in the kitchen prepares each plate on demand. You must **wait for the next plate to be delivered** (`await iterator.next()`) before you can eat it and ask for the next one.

```typescript
// ❌ Naive / Broken Code: Eager Materialization of Infinite Async Iterables
async function fetchAllLogs(logGenerator: AsyncIterable<string>) {
  const allLogs: string[] = [];

  // EAGER MATERIALIZATION MEMORY BLOWUP!
  // If logGenerator yields millions of logs or streams indefinitely, 
  // accumulating them into an array will cause an Out-Of-Memory (OOM) crash!
  for await (const log of logGenerator) {
    allLogs.push(log);
  }

  return allLogs;
}
```

---

## 2. 🔬 Deep Architectural Breakdown & Engine Mechanics

### The `Symbol.asyncIterator` Protocol

Just as synchronous iteration relies on `Symbol.iterator`, asynchronous iteration relies on `Symbol.asyncIterator`.

```typescript
interface AsyncIteratorResult<T> {
  value: T;
  done: boolean;
}

interface AsyncIterator<T> {
  next(): Promise<AsyncIteratorResult<T>>;
  return?(value?: any): Promise<AsyncIteratorResult<T>>;
  throw?(error?: any): Promise<AsyncIteratorResult<T>>;
}

interface AsyncIterable<T> {
  [Symbol.asyncIterator](): AsyncIterator<T>;
}
```

### How `for await...of` Desugars Under the Hood

When V8 executes a `for await...of` loop, it desugars into an explicit `try...finally` block that manages iterator lifecycle and resource cleanup:

```typescript
// HIGH LEVEL:
for await (const item of asyncIterable) {
  process(item);
}

// DESUGARED EQUIVALENT:
const iterator = asyncIterable[Symbol.asyncIterator]();
try {
  while (true) {
    const { value, done } = await iterator.next();
    if (done) break;
    process(value);
  }
} finally {
  // CRITICAL: Guaranteed cleanup if loop breaks, returns, or throws!
  if (typeof iterator.return === 'function') {
    await iterator.return();
  }
}
```

```mermaid
sequenceDiagram
    autonumber
    actor Consumer
    participant Loop as for await...of
    participant Iterator as AsyncIterator
    participant Source as Async Generator / Stream

    Consumer->>Loop: Start Loop
    Loop->>Iterator: [Symbol.asyncIterator]()
    loop Until done == true
        Loop->>Iterator: await next()
        Iterator->>Source: Fetch/produce next value asynchronously
        Source-->>Iterator: Fulfills Promise<{value, done}>
        Iterator-->>Loop: Yields unwrapped value
        Loop->>Consumer: Execute loop body
    end
    opt Early Break or Exception
        Loop->>Iterator: await return() (Resource Cleanup)
    end
```

### Node.js Streams & Async Iteration

Node.js Readable Streams natively implement `Symbol.asyncIterator`. Each iteration yields a `Buffer` or `string` chunk as data becomes available from the OS network or filesystem buffer:

```typescript
import fs from 'node:fs';

// Readable streams can be consumed natively via for await...of
const stream = fs.createReadStream('large-file.ndjson', { encoding: 'utf8' });

for await (const chunk of stream) {
  // Backpressure is handled automatically by the iterator pausing next() calls!
}
```

---

## 3. 💻 Complete Production Code + Line-by-Line Annotations

Save this complete implementation to `async-iteration.ts`:

```typescript
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

// 1. Async Generator Function simulating paginated API fetching
async function* fetchPaginatedUsers(pageSize: number = 2): AsyncGenerator<{ id: number; name: string }, void, unknown> {
  let page = 1;
  const maxPages = 3;

  while (page <= maxPages) {
    console.log(`📡 Fetching API Page ${page}...`);
    await sleep(100); // Simulate network latency

    const mockUsers = [
      { id: (page - 1) * pageSize + 1, name: `User_${(page - 1) * pageSize + 1}` },
      { id: (page - 1) * pageSize + 2, name: `User_${(page - 1) * pageSize + 2}` },
    ];

    for (const user of mockUsers) {
      yield user; // Yields individual items wrapped in a Promise
    }

    page += 1;
  }
}

// 2. Custom Async Iterable Class
class AsynchronousCounter implements AsyncIterable<number> {
  constructor(private limit: number) {}

  [Symbol.asyncIterator](): AsyncIterator<number> {
    let current = 1;
    const limit = this.limit;

    return {
      async next(): Promise<IteratorResult<number>> {
        if (current <= limit) {
          await sleep(50);
          const value = current;
          current += 1;
          return { value, done: false };
        }
        return { value: undefined as any, done: true };
      },
      async return(): Promise<IteratorResult<number>> {
        console.log('🧹 AsynchronousCounter iterator cleanup invoked!');
        return { value: undefined as any, done: true };
      }
    };
  }
}

// Quick Execution Demonstration
async function run() {
  console.log('1. --- Consuming Async Generator ---');
  for await (const user of fetchPaginatedUsers()) {
    console.log(`  -> Received user: ${user.name}`);
  }

  console.log('\n2. --- Consuming Custom Async Iterable with Early Break ---');
  const counter = new AsynchronousCounter(5);
  for await (const count of counter) {
    console.log(`  -> Count: ${count}`);
    if (count === 2) {
      console.log('  🛑 Breaking early...');
      break; // Triggers counter.return()!
    }
  }

  console.log('\n3. --- Node Stream Interop via Readable.from() ---');
  const asyncIterableSource = (async function* () {
    yield 'Chunk 1 ';
    yield 'Chunk 2 ';
    yield 'Chunk 3';
  })();

  const readableStream = Readable.from(asyncIterableSource);
  readableStream.on('data', (chunk) => {
    console.log(`  -> Stream data event: "${chunk}"`);
  });
}

run();
```

---

## 4. ⚠️ Real-World Failure Modes & Security Edge Cases

### 1. Manual Async Iteration Resource Leaks
When consuming an async iterator manually (without `for await...of`), developers often call `.next()` inside a `while` loop but forget to invoke `iterator.return()` inside a `try...finally` block when an error occurs.
- **Consequence**: Leaked database cursors, open sockets, or dangling file handles. Always prefer `for await...of` or wrap manual iteration in `try...finally`.

### 2. Assuming `for await...of` Replaces Full Stream Pipelines
While `for await...of` pauses fetching while processing a chunk, it does **not** provide comprehensive stream error handling or automatic multi-stage pipe composition. For complex transformations with multiple destinations, use `stream.pipeline()`.

### 3. Mixing Sync and Async Iterators in High-Throughput Pipelines
Accidentally calling a synchronous `.map()` on an async iterator array conversion forces all chunks to buffer in memory before processing can start, destroying stream throughput.

---

## 5. 🛠️ Hands-On Guided Exercise & Reference Solution

### The Challenge

Write a generic async generator pipeline transformer `batchAsyncIterable`:

```typescript
export async function* batchAsyncIterable<T>(
  source: AsyncIterable<T>,
  batchSize: number
): AsyncGenerator<T[], void, unknown>
```

Requirements:
1. Consumes items from `source` one by one.
2. Accumulates items into batches up to `batchSize`.
3. Yields each batch array (`T[]`).
4. Flushes any remaining items in a partial final batch when `source` is exhausted.

### Reference Solution

```typescript
/**
 * Transforms an async iterable stream into buffered batches of a specified size.
 */
export async function* batchAsyncIterable<T>(
  source: AsyncIterable<T>,
  batchSize: number
): AsyncGenerator<T[], void, unknown> {
  if (batchSize <= 0) {
    throw new Error('Batch size must be greater than 0');
  }

  let currentBatch: T[] = [];

  for await (const item of source) {
    currentBatch.push(item);

    if (currentBatch.length === batchSize) {
      yield currentBatch;
      currentBatch = []; // Reset batch buffer
    }
  }

  // Yield remaining partial batch if non-empty
  if (currentBatch.length > 0) {
    yield currentBatch;
  }
}

// Quick Test Demonstration:
async function demoBatcher() {
  // Source generator yielding numbers 1..7
  async function* generateNumbers() {
    for (let i = 1; i <= 7; i += 1) {
      yield i;
    }
  }

  console.log('📦 Batching stream items in groups of 3...');
  
  for await (const batch of batchAsyncIterable(generateNumbers(), 3)) {
    console.log('  -> Batch yielded:', batch);
  }
}

demoBatcher();
```
