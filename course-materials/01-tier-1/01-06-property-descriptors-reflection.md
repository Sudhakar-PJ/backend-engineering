# Property Descriptors & Reflection

## Overview

Property descriptors and reflection APIs (`Object.defineProperty`, `Object.getOwnPropertyDescriptor`, `Proxy`, and `Reflect`) form JavaScript's core metaprogramming engine. In modern backend engineering, these primitives power dynamic infrastructure components such as ORM change-tracking (dirty checking), lazy-loading relations, runtime schema validation wrappers, RPC client proxies, dependency injection containers, and performance profiling decorators.

Understanding how property descriptors operate at the V8 object shape level—and how `Proxy` traps interact with `Reflect` receiver context—is essential for diagnosing subtle bugs in framework internals and building high-performance Node.js server applications.

---

## Key Concepts & Architecture

### 1. Internal V8 Property Descriptors

Every property on a JavaScript object is represented internally by a descriptor schema. Property descriptors fall strictly into two categories:

* **Data Descriptors**: Properties that store an explicit value.
  * `value`: The actual data value stored on the key.
  * `writable`: Boolean flag indicating if property reassignment via `=` is permitted.
  * `enumerable`: Boolean flag determining if the property appears during iteration (`for...in`, `Object.keys()`, `JSON.stringify()`).
  * `configurable`: Boolean flag controlling whether property attributes can be altered or if the property can be deleted from the target object.
* **Accessor Descriptors**: Properties defined by getter and setter functions.
  * `get`: Function executed when accessing the property value.
  * `set`: Function executed when assigning a value to the property key.
  * `enumerable`: Same as data descriptor.
  * `configurable`: Same as data descriptor.

> ⚠️ **Descriptor Constraint**: A property descriptor cannot mix `value`/`writable` keys with `get`/`set` keys; attempting to do so throws a runtime `TypeError`.

```javascript
// Inspecting internal property descriptor attributes
const user = {};
Object.defineProperty(user, 'id', {
  value: 'usr_109283',
  writable: false,     // Immutable ID
  enumerable: true,    // Visible in JSON/keys
  configurable: false  // Protection against deletion/re-configuration
});

// Accessing descriptor metadata
const descriptor = Object.getOwnPropertyDescriptor(user, 'id');
console.log(descriptor);
// Output: { value: 'usr_109283', writable: false, enumerable: true, configurable: false }
```

---

### 2. Reflection APIs (`Reflect`)

The global `Reflect` built-in object provides static functional methods for interceptable JavaScript operations. Unlike corresponding legacy `Object` methods:

1. **Boolean Return Status**: `Reflect` methods return explicit booleans rather than throwing uncaught errors (e.g., `Reflect.defineProperty(target, key, desc)` returns `false` on failure, while `Object.defineProperty` throws in strict mode).
2. **1:1 Alignment with Proxy Traps**: Every `Proxy` handler trap has an exact matching `Reflect` signature (`Reflect.get`, `Reflect.set`, `Reflect.has`, `Reflect.deleteProperty`, `Reflect.apply`, `Reflect.construct`).
3. **Correct Receiver Context Handling**: Passing the `receiver` argument to `Reflect.get(target, prop, receiver)` ensures correct prototype inheritance and `this` binding inside getters.

```javascript
// Safe property definition with Reflect
const config = {};
const success = Reflect.defineProperty(config, 'PORT', {
  value: 8080,
  writable: false,
  enumerable: true,
  configurable: false
});

if (!success) {
  console.error('Failed to configure PORT property');
}
```

---

### 3. Proxies (`Proxy`) & Trap Mechanics

A `Proxy` wraps a target object, allowing custom handler traps to intercept fundamental language operations:

```mermaid
flowchart LR
    Caller["Caller / Consumer Code"] -->|obj.propertyName| Proxy["Proxy Wrapper"]
    Proxy -->|Trap: get(target, prop, receiver)| TrapHandler["Handler Function"]
    TrapHandler -->|Reflect.get(target, prop, receiver)| Target["Target Object"]
    Target -->|Result| Caller
```

---

## Complete Production Code Annotations

### Production Case Study: Building an ORM Change-Tracking (Dirty Checking) Proxy

ORMs like TypeORM, MikroORM, and Hibernate track modified properties on entity models to execute targeted SQL `UPDATE` statements containing only altered columns.

```javascript
/**
 * Creates an entity wrapped in a change-tracking Proxy.
 * @param {Object} targetEntity - The base data entity model.
 * @returns {Object} Object containing tracked proxy and dirty state inspection.
 */
function createTrackedEntity(targetEntity) {
  const dirtyFields = new Set();
  const originalValues = new Map();

  const proxy = new Proxy(targetEntity, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      // If the property is a nested object, recursive proxying can be applied here
      return value;
    },

    set(target, property, value, receiver) {
      const currentValue = Reflect.get(target, property, receiver);

      if (currentValue !== value) {
        // Track the first original value before modifications
        if (!originalValues.has(property)) {
          originalValues.set(property, currentValue);
        }

        dirtyFields.add(property);
      }

      // Execute actual property update via Reflect to preserve invariants
      return Reflect.set(target, property, value, receiver);
    },

    deleteProperty(target, property) {
      if (Reflect.has(target, property)) {
        dirtyFields.add(property);
      }
      return Reflect.deleteProperty(target, property);
    }
  });

  return {
    entity: proxy,
    isDirty: () => dirtyFields.size > 0,
    getDirtyFields: () => Array.from(dirtyFields),
    getOriginalValues: () => Object.fromEntries(originalValues),
    resetTracking: () => {
      dirtyFields.clear();
      originalValues.clear();
    }
  };
}

// Example usage in an ORM repository layer:
const userModel = { id: 42, email: 'user@domain.com', role: 'member' };
const { entity: user, isDirty, getDirtyFields, getOriginalValues } = createTrackedEntity(userModel);

// Entity mutation
user.email = 'updated_user@domain.com';

console.log('Is Dirty:', isDirty()); // true
console.log('Dirty Fields:', getDirtyFields()); // ['email']
console.log('Original State:', getOriginalValues()); // { email: 'user@domain.com' }

// Generated SQL Query: UPDATE users SET email = 'updated_user@domain.com' WHERE id = 42;
```

---

## Real-World Failure Modes & Security Edge Cases

1. **Proxy Target Invariants Violation**:
   If a property on the target object is marked non-writable and non-configurable, a `Proxy` `get` trap *must* return the exact target property value. If the trap returns a different value, V8 throws an uncaught `TypeError: 'get' on proxy: property 'x' is a read-only and non-configurable data property...`.

2. **Private Fields (`#privateField`) & Native Receiver Binding Loss**:
   Proxies do not automatically pass internal private brand checks or native internal slots (e.g., `Map.prototype.get`, `Set.prototype.add`, `Date.prototype.getTime`). Accessing native methods on a Proxied instance causes `TypeError: Method Map.prototype.get called on incompatible receiver #<Object>`.
   * **Fix**: Bind method calls to the unproxied target object or pass target explicitly inside the function invocation.

```javascript
// Native Receiver Loss Trap Example
const map = new Map();
const proxyMap = new Proxy(map, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value === 'function') {
      // Must bind native methods back to original target!
      return value.bind(target);
    }
    return value;
  }
});

proxyMap.set('key', 'value'); // Works safely with bind fix
```

3. **Performance Overhead of Nested Proxies**:
   While `Proxy` lookups are heavily optimized in V8, executing heavy proxy traps inside high-throughput hot loops (e.g., parsing 100,000 JSON records per second) introduces noticeable performance penalties compared to raw object property access.
