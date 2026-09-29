// export interface EventPayload {
//   id: string;
//   type: string;
//   timestamp: number;
//   data: Record<string, unknown>;
// }

// export abstract class BaseProcessor {
//   static #totalProcessedCount: number = 0;

//   static {
//     this.#totalProcessedCount = 0;
//   }

//   readonly createdAt: Date = new Date();

//   #isShutdown: boolean = false;

//   constructor(public readonly processorId: string) {
//     if (!processorId) {
//       throw new Error("Processor ID must be a non-empty string");
//     }
//   }
//   static get totalProcessedCount(): number {
//     return BaseProcessor.#totalProcessedCount;
//   }

//   protected static incrementGlobalCount(amount: number): void {
//     if (amount <= 0) {
//       throw new Error("Amount must be a positive number.");
//     }
//     BaseProcessor.#totalProcessedCount += amount;
//   }

//   get isShutdown(): boolean {
//     return this.#isShutdown;
//   }

//   static isBaseProcessor(obj: unknown): boolean {
//     if (typeof obj !== "object" || obj === null) return false;
//     return #isShutdown in obj;
//   }

//   shutdown(): void {
//     if (this.#isShutdown) {
//       throw new Error(`Processor [${this.processorId}] is already shut down.`);
//     }
//     this.#isShutdown = true;
//   }

//   abstract processBatch(events: EventPayload[]): Promise<number>;
// }

// export class TelemetryEventProcessor extends BaseProcessor {
//   #maxBatchSize: number;
//   #processedEventIds: Set<string> = new Set();

//   constructor(processorId: string, maxBatchSize: number = 100) {
//     super(processorId);

//     if (maxBatchSize <= 0) {
//       throw new Error("Max batch size must be a positive number");
//     }
//     this.#maxBatchSize = maxBatchSize;
//   }

//   async processBatch(events: EventPayload[]): Promise<number> {
//     if (this.isShutdown) {
//       throw new Error(
//         `Cannot process batch: Processor [${this.processorId}] is shut down.`,
//       );
//     }

//     if (events.length > this.#maxBatchSize) {
//       throw new Error(
//         `Batch size ${events.length} exceeds limit of ${this.#maxBatchSize}`,
//       );
//     }

//     let newlyProcessedCount = 0;

//     for (const event of events) {
//       if (this.#processedEventIds.has(event.id)) {
//         continue;
//       }
//       this.#processedEventIds.add(event.id);
//       newlyProcessedCount++;
//     }

//     BaseProcessor.incrementGlobalCount(newlyProcessedCount);
//     return newlyProcessedCount;
//   }
// }

abstract class RateLimiter {
  #capacity: number;

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new Error("Capacity must be strictly positive.");
    }
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  abstract tryConsume(tokens: number): boolean;
}

class TokenBucketRateLimiter extends RateLimiter {
  #tokens: number;
  #fillRatePerSec: number;

  constructor(capacity: number, fillRatePerSec: number) {
    super(capacity); // Must be first!

    if (fillRatePerSec <= 0) {
      throw new Error("Fill rate must be positive.");
    }

    this.#fillRatePerSec = fillRatePerSec;
    this.#tokens = capacity; // Start at full capacity
  }

  get tokens(): number {
    return this.#tokens;
  }

  refill(elapsedSeconds: number): void {
    if (elapsedSeconds < 0) return;
    const added = elapsedSeconds * this.#fillRatePerSec;
    this.#tokens = Math.min(this.capacity, this.#tokens + added);
  }

  tryConsume(tokens: number): boolean {
    if (tokens <= 0) {
      throw new Error("Tokens requested must be positive.");
    }
    if (this.#tokens >= tokens) {
      this.#tokens -= tokens;
      return true;
    }
    return false;
  }
}

// Verification usage
const limiter = new TokenBucketRateLimiter(10, 2); // capacity 10, 2 tokens/sec
console.log(limiter.tryConsume(8)); // true (2 tokens left)
console.log(limiter.tryConsume(5)); // false (not enough tokens)
limiter.refill(2); // refills 4 tokens -> 6 total
console.log(limiter.tryConsume(5)); // true (1 token left)
