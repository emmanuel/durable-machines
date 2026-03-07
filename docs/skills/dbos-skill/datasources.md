# DBOS Datasource Transactions

## Overview

A DBOS **transaction** is a special kind of step that runs a function inside a database transaction and records its return value within that same transaction. This guarantees **exactly-once execution** — even in the face of retries or failures.

Datasources are implemented as separate npm packages. Each wraps a popular database access library.

## Available Datasource Packages

| Package | Library | Install |
|---|---|---|
| `@dbos-inc/knex-datasource` | Knex query builder | `npm install @dbos-inc/knex-datasource knex` |
| `@dbos-inc/drizzle-datasource` | Drizzle ORM | `npm install @dbos-inc/drizzle-datasource drizzle-orm` |
| `@dbos-inc/prisma-datasource` | Prisma ORM | `npm install @dbos-inc/prisma-datasource @prisma/client` |
| `@dbos-inc/typeorm-datasource` | TypeORM | `npm install @dbos-inc/typeorm-datasource typeorm` |

---

## Knex Datasource

### Setup

```ts
import { KnexDataSource } from "@dbos-inc/knex-datasource";

const ds = new KnexDataSource("appDb", {
  client: "pg",
  connection: process.env.DATABASE_URL,
});
```

Datasources should be constructed during program load (before `DBOS.launch()`). They don't open connections until `DBOS.launch()` is called.

### Decorator Style

```ts
class OrderRepo {
  @ds.transaction()
  static async createOrder(orderId: string, total: number): Promise<void> {
    await ds.client.raw(
      "INSERT INTO orders (id, total, status) VALUES (?, ?, ?)",
      [orderId, total, "pending"]
    );
  }

  @ds.transaction()
  static async updateOrderStatus(orderId: string, status: string): Promise<void> {
    await ds.client("orders").where({ id: orderId }).update({ status });
  }

  @ds.transaction({ isolationLevel: "serializable" })
  static async getAndIncrementCounter(name: string): Promise<number> {
    const [row] = await ds.client("counters").where({ name }).forUpdate();
    const newValue = (row?.value ?? 0) + 1;
    await ds.client("counters")
      .insert({ name, value: newValue })
      .onConflict("name")
      .merge();
    return newValue;
  }
}
```

### Functional Style

```ts
const createOrder = ds.registerTransaction(
  async (orderId: string, total: number) => {
    await ds.client.raw(
      "INSERT INTO orders (id, total, status) VALUES (?, ?, ?)",
      [orderId, total, "pending"]
    );
  },
  { name: "createOrder" }
);

const getOrder = ds.registerTransaction(
  async (orderId: string) => {
    const [order] = await ds.client("orders").where({ id: orderId });
    return order;
  },
  { name: "getOrder" }
);
```

### Inline Style

```ts
// Inside a workflow
const order = await ds.runTransaction(
  async () => {
    const [row] = await ds.client("orders").where({ id: orderId });
    return row;
  },
  { name: "getOrder" }
);
```

### Transaction Configuration

```ts
interface TransactionConfig {
  name?: string;
  isolationLevel?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';
}
```

---

## Drizzle Datasource

### Setup

```ts
import { DrizzleDataSource } from "@dbos-inc/drizzle-datasource";
import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";

// Define schema
const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  customerId: text("customer_id").notNull(),
  total: integer("total").notNull(),
  status: text("status").notNull().default("pending"),
});

const ds = new DrizzleDataSource("appDb", {
  connectionString: process.env.DATABASE_URL,
});
```

### Usage

```ts
class OrderRepo {
  @ds.transaction()
  static async createOrder(customerId: string, total: number) {
    const [order] = await ds.client
      .insert(orders)
      .values({ customerId, total })
      .returning();
    return order;
  }

  @ds.transaction()
  static async getOrdersByCustomer(customerId: string) {
    return await ds.client
      .select()
      .from(orders)
      .where(eq(orders.customerId, customerId));
  }
}
```

---

## Prisma Datasource

### Setup

```ts
import { PrismaDataSource } from "@dbos-inc/prisma-datasource";

const ds = new PrismaDataSource("appDb", {
  datasourceUrl: process.env.DATABASE_URL,
});
```

### Usage

```ts
class OrderRepo {
  @ds.transaction()
  static async createOrder(customerId: string, total: number) {
    return await ds.client.order.create({
      data: { customerId, total, status: "pending" },
    });
  }

  @ds.transaction()
  static async getOrder(orderId: string) {
    return await ds.client.order.findUnique({
      where: { id: orderId },
    });
  }
}
```

---

## TypeORM Datasource

### Setup

```ts
import { TypeORMDataSource } from "@dbos-inc/typeorm-datasource";

const ds = new TypeORMDataSource("appDb", {
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: [Order],
  synchronize: false,
});
```

### Usage

```ts
class OrderRepo {
  @ds.transaction()
  static async createOrder(customerId: string, total: number) {
    const repo = ds.client.getRepository(Order);
    const order = repo.create({ customerId, total, status: "pending" });
    return await repo.save(order);
  }
}
```

---

## How Exactly-Once Works

The datasource writes the transaction's result to a **checkpoint table** in the same database transaction as the user's operation. This means:

1. The user's SQL operations and the checkpoint write commit atomically.
2. On recovery, if the checkpoint exists, the transaction is NOT re-executed — the cached result is returned.
3. If the checkpoint doesn't exist, the transaction executes normally.

This provides **exactly-once execution** for database operations, which is stronger than the "at-least-once" guarantee of regular steps.

---

## Important Notes

### Application Database vs System Database

- The **system database** stores DBOS internal state (workflow checkpoints, step outputs, etc.).
- The **application database** (used by transactions) stores your application data.
- They **can be the same** Postgres instance or different ones.
- The datasource checkpoint table lives in the application database.

### Transactions Are Steps

Transactions are a special kind of step. They follow the same rules:
- Can only be called from within workflows (or standalone without durability).
- Cannot start new workflows from within a transaction.
- Return values must be serializable.

### Outside Workflows

Transactions can be called outside of workflows, but without durability guarantees — they simply execute as normal database transactions.

### Isolation Level

Configure transaction isolation level per-transaction:

```ts
@ds.transaction({ isolationLevel: "serializable" })
static async criticalOperation() { /* ... */ }
```

Default isolation level depends on the underlying library (typically `read committed` for Postgres).

---

## Using Transactions in Workflows

```ts
import { DBOS } from "@dbos-inc/dbos-sdk";
import { KnexDataSource } from "@dbos-inc/knex-datasource";

const ds = new KnexDataSource("appDb", {
  client: "pg",
  connection: process.env.DATABASE_URL,
});

class OrderService {
  // Transaction: exactly-once database write
  @ds.transaction()
  static async saveOrder(order: Order): Promise<string> {
    const [row] = await ds.client("orders").insert(order).returning("id");
    return row.id;
  }

  // Regular step: external API call (at-least-once)
  @DBOS.step({ retriesAllowed: true, maxAttempts: 3 })
  static async chargePayment(orderId: string, amount: number): Promise<string> {
    const res = await fetch("https://payments.example.com/charge", {
      method: "POST",
      body: JSON.stringify({ orderId, amount }),
    });
    return (await res.json()).chargeId;
  }

  // Transaction: update order status
  @ds.transaction()
  static async markOrderPaid(orderId: string, chargeId: string): Promise<void> {
    await ds.client("orders").where({ id: orderId }).update({
      status: "paid",
      charge_id: chargeId,
    });
  }

  // Workflow: orchestrates transactions and steps
  @DBOS.workflow()
  static async processOrder(order: Order): Promise<string> {
    const orderId = await OrderService.saveOrder(order);          // Exactly-once
    const chargeId = await OrderService.chargePayment(orderId, order.amount); // At-least-once (with retries)
    await OrderService.markOrderPaid(orderId, chargeId);          // Exactly-once
    return orderId;
  }
}
```

This pattern gives you the strongest guarantees: exactly-once for DB writes, at-least-once with retries for external APIs, and the entire workflow is durable and recoverable.
