export interface RateLimiter {
    isAllowed: (clientId: string) =>boolean;
    getMetrics: () => Record<string, number>
}

export function createRateLimiter(maxRequests: number, windowMs: number): RateLimiter {
    const clientRequestLogs = new Map<string, number[]>();

    return {
        isAllowed: (clientId: string): boolean => {
            const now = Date.now();
            const windowStart = now - windowMs;

            let timeStamps = clientRequestLogs.get(clientId);
            if(!timeStamps) {
                timeStamps = [];
                clientRequestLogs.set(clientId, timeStamps);
            }

            //clean up old timestamps
            {
                const validTimeStamps = timeStamps.filter((ts) => ts > windowStart)
                timeStamps.length = 0;
                timeStamps.push(...validTimeStamps)
            }
            if(timeStamps.length < maxRequests) {
                timeStamps.push(now);
                return true;
            }
            return false;
        },
        getMetrics: (): Record<string, number> => {
            const metrics: Record<string, number> = {};
            for(const [clientId, timeStamps] of clientRequestLogs.entries()){
                metrics[clientId] = timeStamps.length;
            }
            return metrics;
        }
    }
}

// --- Execution Test Driver ---
// Run with: npx tsx projects/t1-cli/scope-exercises.ts

console.log("=== Rate Limiter Scope & Closure Test ===\n");

// Allow max 3 requests per 1000ms window
const limiter = createRateLimiter(3, 1000);

console.log("Checking client 'user_A':");
console.log("Request 1:", limiter.isAllowed("user_A")); // true
console.log("Request 2:", limiter.isAllowed("user_A")); // true
console.log("Request 3:", limiter.isAllowed("user_A")); // true
console.log("Request 4 (exceeds limit):", limiter.isAllowed("user_A")); // false

console.log("\nChecking client 'user_B' (isolated state):");
console.log("Request 1:", limiter.isAllowed("user_B"));// true
console.log("Request 2:", limiter.isAllowed("user_B"));// true
console.log("Request 3:", limiter.isAllowed("user_B"));// true
console.log("Request 4:", limiter.isAllowed("user_B"));// true
console.log("Request 5:", limiter.isAllowed("user_B"));// true
console.log("Request 6:", limiter.isAllowed("user_a"));// true

console.log("\nActive Metrics:", limiter.getMetrics());