export interface QueueMetrics {
    executedTasks: number;
    failedTasks: number;
}

export class TaskQueueRunner {
    private executedCount = 0;
    private failedCount = 0;

    private recordSuccess = (): void => {
        this.executedCount++;
    };

    private recordFailure = (): void => {
        this.failedCount++;
    };

    public runTaskWithSafety = async (task: ()=> Promise<void>): Promise<boolean> => {
        try {
            await task();
            this.recordSuccess();
            return true;
        } catch (err) {
            this.recordFailure();
            return false;
        }
    }

    public getMetrics = (): QueueMetrics => {
        return {
            executedTasks: this.executedCount,
            failedTasks: this.failedCount
        };
    };
}

// --- Execution Test Driver ---
// Run with: npx tsx projects/t1-cli/this-exercise.ts

async function main() {
    console.log("=== Task Queue Runner 'this' Binding Test ===\n");

    const runner = new TaskQueueRunner();

    // 1. Successful task execution
    const successTask = async () => {
        console.log("  Executing successful async task...");
    };

    // 2. Failing task execution
    const failingTask = async () => {
        console.log("  Executing failing async task...");
        throw new Error("Task execution failed!");
    };

    console.log("1. Running tasks via direct method invocation:");
    await runner.runTaskWithSafety(successTask);
    await runner.runTaskWithSafety(failingTask);
    console.log("Metrics:", runner.getMetrics());

    console.log("\n2. Detaching methods to test 'this' preservation:");
    // Destructuring method off instance (standalone callback test)
    const { runTaskWithSafety, getMetrics } = runner;

    // Execute detached method
    await runTaskWithSafety(successTask);
    await runTaskWithSafety(failingTask);

    // Call detached getMetrics function
    const currentMetrics = getMetrics();
    console.log("Metrics via detached getMetrics():", currentMetrics);
}

main().catch(console.error);








