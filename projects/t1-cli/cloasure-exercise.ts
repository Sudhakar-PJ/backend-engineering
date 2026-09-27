export interface BatchProcessor<T> {
    addItem: (item: T) => void;
    flushRemaining: () => void;
    getPendingCount: () => number;
}

export function createBatchProcessor<T>(
    batchSize: number,
    flushCallback: (batch: T[]) => void
): BatchProcessor<T> {
    let pendingQueue: T[] =[];

    return {
        addItem: (item: T): void => {
            pendingQueue.push(item);

            if(pendingQueue.length >=batchSize){
                const batchToFlush = pendingQueue;
                pendingQueue = [];
                flushCallback(batchToFlush)
            }
        },
        flushRemaining: (): void => {
            if(pendingQueue.length > 0) {
                const batchToFlush = pendingQueue;
                pendingQueue = [];
                flushCallback(batchToFlush)
            }
        },
        getPendingCount(): number {
            return pendingQueue.length;
        },
    };
}

// --- Execution Test Driver ---
// Run with: npx tsx projects/t1-cli/cloasure-exercise.ts

console.log("=== Batch Processor Closure Test ===\n");

// Pass a custom flushCallback to log flushed batches
const flushedBatches: string[][] = [];

const processor = createBatchProcessor<string>(3, (batch) => {
    console.log("🔥 Flush callback triggered! Processing batch:", batch);
    flushedBatches.push(batch);
});

console.log("Adding item 1: 'event_A'");
processor.addItem("event_A");
console.log("Pending items count:", processor.getPendingCount());

console.log("\nAdding item 2: 'event_B'");
processor.addItem("event_B");
console.log("Pending items count:", processor.getPendingCount());

console.log("\nAdding item 3: 'event_C' (should trigger automatic flush)");
processor.addItem("event_C"); // Triggers batch flush of size 3!
console.log("Pending items count after auto-flush:", processor.getPendingCount());

console.log("\nAdding item 4: 'event_D'");
processor.addItem("event_D");
console.log("Pending items count:", processor.getPendingCount());

console.log("\nFlushing remaining items on shutdown:");
processor.flushRemaining(); // Flushes leftover ['event_D']
console.log("Pending items count after final flush:", processor.getPendingCount());




