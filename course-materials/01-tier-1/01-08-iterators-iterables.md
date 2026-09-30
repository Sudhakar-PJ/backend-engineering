# Iterators & Iterables

## 1. 💡 Intuition & ELI5 Analogy

Think of an **Iterable** like a book, and an **Iterator** like a bookmark inside that book. The book itself does not keep track of where you are reading; the bookmark stores the exact current page position. Every time you turn to the next page (invoke `.next()`), the bookmark moves forward until you reach the last page (`done: true`).

In backend engineering, iterators allow streaming and processing massive datasets (million-row database queries, multi-gigabyte log files, API cursors) item-by-item in memory without ever allocating huge contiguous arrays on the V8 heap.

```javascript
// NAIVE / BROKEN (Eagerly loading 10 million log lines into memory)
// Triggers Heap Allocation Failure & V8 Out-Of-Memory (OOM) Crash!
const allLogs = fs.readFileSync('huge-server-log.txt', 'utf-8').split('\n');
```

---

## 2. 🔬 Deep Architectural Breakdown & Engine Mechanics

### The Iteration Protocols

JavaScript standardizes object iteration via two formal protocols:

1. **The Iterable Protocol**: An object is iterable if it implements a `[Symbol.iterator]` method (or `[Symbol.asyncIterator]` for async data sources) that returns an iterator object.
2. **The Iterator Protocol**: An object providing a `.next()` method that returns an object containing `{ value: any, done: boolean }`.

```mermaid
flowchart LR
    Consumer["Consumer Code (for...of / Spread / Destructure)"] -->|1. Call [Symbol.iterator]()| Iterable["Iterable Object"]
    Iterable -->|2. Return Iterator| Iterator["Iterator Object"]
    Consumer -->|3. Invoke .next()| Iterator
    Iterator -->|4. Return { value, done: false }| Consumer
    Iterator -->|5. Return { value: undefined, done: true }| Consumer
```

### Generator Functions (`function*`) & Stack Frame Suspension

Generators (`function*` syntax) are low-level state machines that simplify writing custom iterators.

* **Stack Frame Suspension**: When execution encounters a `yield` expression, the engine pauses the function execution, serializes its local scope stack frame, and yields the value to the caller.
* **Resumption**: Calling `.next(inputValue)` restores the stack frame and resumes execution immediately after the `yield` statement, optionally injecting `inputValue` back into the function scope.
* **Delegation (`yield*`)**: Delegates iteration control to another nested generator or iterable object efficiently.

---

## 3. 💻 Complete Production Code + Line-by-Line Annotations

### Production Case Study: Memory-Efficient Database Cursor & Batch Transformer

Below is a production-grade custom iterator class simulating streaming database records in controlled batches:

```javascript
/**
 * Custom Iterable Class for Streaming Large Database Pages
 */
class DatabaseQueryCursor {
  /**
   * @param {number} totalRecords - Total records available in database query
   * @param {number} pageSize - Number of records to fetch per DB network roundtrip
   */
  constructor(totalRecords, pageSize = 2) {
    this.totalRecords = totalRecords;
    this.pageSize = pageSize;
  }

  /**
   * Implements the native Iterable Protocol via a Generator method
   */
  *[Symbol.iterator]() {
    let fetched = 0;
    let page = 1;

    while (fetched < this.totalRecords) {
      // Simulate fetching a single batch/page from DB into memory
      const currentBatchSize = Math.min(this.pageSize, this.totalRecords - fetched);
      const batch = Array.from({ length: currentBatchSize }, (_, i) => ({
        id: fetched + i + 1,
        payload: `Record payload ID ${fetched + i + 1} (Fetched in Page ${page})`
      }));

      // Yielding elements one-by-one to consumer without buffering entire dataset
      for (const record of batch) {
        yield record;
      }

      fetched += currentBatchSize;
      page++;
    }
  }
}

/**
 * Generator Transformer: Filters & Enriches items lazily
 */
function* transformRecords(cursor, roleFilter) {
  for (const record of cursor) {
    // Perform transformation lazily per item
    if (record.id % 2 === 0) { // Example condition filter
      yield {
        ...record,
        status: 'PROCESSED',
        processedAt: new Date().toISOString()
      };
    }
  }
}

// Execution Demo
const cursor = new DatabaseQueryCursor(5, 2);
const pipeline = transformRecords(cursor, 'ADMIN');

console.log('--- Lazy Stream Iteration Output ---');
for (const processedRecord of pipeline) {
  console.log('Consumer Received:', processedRecord);
}
```

---

## 4. ⚠️ Real-World Failure Modes & Security Edge Cases

1. **Infinite Generator Traps & Unintended Materialization**:
   If a generator contains an infinite loop (`while (true) { yield ++id; }`), using eager evaluation syntaxes like `Array.from(generator)`, spread `[...generator]`, or `Object.values()` will freeze the event loop and crash Node.js with an Out-of-Memory (OOM) error.

2. **Single-Use Generator Exhaustion**:
   A generator instance is a stateful iterator. Once it returns `{ done: true }`, re-invoking `for...of` or `.next()` on the exact same generator instance yields nothing. To re-iterate, a new generator instance must be constructed.

3. **Resource Cleanup & `.return()` Hooks**:
   When a consumer exits a `for...of` loop early via `break`, `return`, or a thrown error, the JS engine automatically calls the iterator's optional `.return()` method. In generator functions, `try ... finally` blocks execute on early loop termination, making it vital to close database connections or open file descriptors inside `finally`.

```javascript
// Safe Generator Resource Cleanup
function* readDatabaseStream(dbClient) {
  try {
    yield dbClient.readRow();
  } finally {
    // Executed automatically if consumer breaks out of for...of early!
    dbClient.closeConnection();
    console.log('[Cleanup] Database connection closed safely.');
  }
}
```
