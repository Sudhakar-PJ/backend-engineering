export class PluginRegistry {
  private config: Record<string, unknown>;

  constructor(defaultConfig: Record<string, unknown>) {
    // Create a dictionary delegating to defaultConfig without mutating it
    this.config = Object.create(defaultConfig);
  }

  // Set an instance-specific override (shadowing)
  public set(key: string, value: unknown): void {
    // Check against prototype pollution keys
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(
        `Security Violation: Refusing to modify prototype key "${key}"`,
      );
    }
    this.config[key] = value;
  }

  // Get configuration key (traverses up prototype chain)
  public get(key: string): unknown {
    return this.config[key];
  }

  // Verify if a property is directly on the instance vs inherited
  public isOverridden(key: string): boolean {
    return Object.hasOwn(this.config, key);
  }

  // Static check for Object.prototype tampering
  public static isPolluted(testKey: string): boolean {
    return Object.prototype.hasOwnProperty(testKey);
  }
}

// --- Execution Test Driver ---
// Run with: npx tsx projects/t1-cli/prototypes-exercise.ts

console.log("=== Testing PluginRegistry ===");

// 1. Initialize registry with default config
const registry = new PluginRegistry({ timeout: 5000, debug: false });

console.log("Default timeout:", registry.get("timeout")); // Expected: 5000
console.log("Default debug:", registry.get("debug")); // Expected: false

// 2. Override debug mode for this instance (Shadowing)
registry.set("debug", true);
console.log("Overridden debug:", registry.get("debug")); // Expected: true
console.log("Is debug overridden?", registry.isOverridden("debug")); // Expected: true
console.log("Is timeout overridden?", registry.isOverridden("timeout")); // Expected: false

// 3. Test Prototype Pollution Prevention
try {
  registry.set("__proto__", { admin: true });
} catch (err: any) {
  console.log("Caught blocked pollution attempt:", err.message);
}

console.log(
  "Is Object.prototype polluted?",
  PluginRegistry.isPolluted("admin"),
); // Expected: false
