import { describe, it, expect } from "vitest";
import { setup } from "xstate";
import {
  durableSetup,
  schemaToFormFields,
  durableState,
  serializeMachineDefinition,
} from "../../src/index.js";

describe("schemaToFormFields()", () => {
  it("converts string fields to text inputs", () => {
    const fields = schemaToFormFields({ name: "string" });
    expect(fields).toEqual([
      { name: "name", label: "name", type: "text", required: true },
    ]);
  });

  it("converts number fields to number inputs", () => {
    const fields = schemaToFormFields({ amount: "number" });
    expect(fields).toEqual([
      { name: "amount", label: "amount", type: "number", required: true },
    ]);
  });

  it("converts boolean fields to checkbox inputs", () => {
    const fields = schemaToFormFields({ active: "boolean" });
    expect(fields).toEqual([
      { name: "active", label: "active", type: "checkbox", required: true },
    ]);
  });

  it("converts date fields to date inputs", () => {
    const fields = schemaToFormFields({ dueDate: "date" });
    expect(fields).toEqual([
      { name: "dueDate", label: "dueDate", type: "date", required: true },
    ]);
  });

  it("marks optional fields as not required", () => {
    const fields = schemaToFormFields({
      name: "string?",
      count: "number?",
    });
    expect(fields).toEqual([
      { name: "name", label: "name", type: "text", required: false },
      { name: "count", label: "count", type: "number", required: false },
    ]);
  });

  it("converts array fields to select inputs with options", () => {
    const fields = schemaToFormFields({
      status: ["draft", "review", "published"],
    });
    expect(fields).toEqual([
      {
        name: "status",
        label: "status",
        type: "select",
        options: ["draft", "review", "published"],
        required: true,
      },
    ]);
  });

  it("handles mixed field types", () => {
    const fields = schemaToFormFields({
      name: "string",
      amount: "number",
      status: ["active", "inactive"],
      notes: "string?",
    });
    expect(fields).toHaveLength(4);
    expect(fields[0].type).toBe("text");
    expect(fields[1].type).toBe("number");
    expect(fields[2].type).toBe("select");
    expect(fields[3].required).toBe(false);
  });

  it("returns empty array for empty schema", () => {
    expect(schemaToFormFields({})).toEqual([]);
  });

  // Object-form field schemas
  it("converts object-form field with type only", () => {
    const fields = schemaToFormFields({ amount: { type: "number" } });
    expect(fields).toEqual([
      { name: "amount", label: "amount", type: "number", required: true },
    ]);
  });

  it("converts object-form field with all metadata", () => {
    const fields = schemaToFormFields({
      amount: {
        type: "number",
        label: "Amount ($)",
        placeholder: "0.00",
        helpText: "Total in USD",
        defaultValue: "100",
        group: "Payment",
      },
    });
    expect(fields).toEqual([
      {
        name: "amount",
        label: "Amount ($)",
        type: "number",
        required: true,
        placeholder: "0.00",
        helpText: "Total in USD",
        defaultValue: "100",
        group: "Payment",
      },
    ]);
  });

  it("converts object-form select with options", () => {
    const fields = schemaToFormFields({
      priority: { type: "select", options: ["normal", "rush"], defaultValue: "normal" },
    });
    expect(fields).toEqual([
      {
        name: "priority",
        label: "priority",
        type: "select",
        options: ["normal", "rush"],
        required: true,
        defaultValue: "normal",
      },
    ]);
  });

  it("handles mixed shorthand and object-form fields", () => {
    const fields = schemaToFormFields({
      name: "string",
      amount: { type: "number", placeholder: "0.00" },
      status: ["draft", "review"],
    });
    expect(fields).toHaveLength(3);
    expect(fields[0]).toEqual({ name: "name", label: "name", type: "text", required: true });
    expect(fields[1].placeholder).toBe("0.00");
    expect(fields[2].type).toBe("select");
  });

  it("handles object-form with required: false", () => {
    const fields = schemaToFormFields({
      notes: { type: "string", required: false },
    });
    expect(fields[0].required).toBe(false);
  });
});

describe("durableSetup()", () => {
  it("returns a setup result with createMachine", () => {
    const s = durableSetup({
      events: {
        PAY: { amount: "number" },
      },
    });
    expect(typeof s.createMachine).toBe("function");
  });

  it("stores event schemas on machine.schemas", () => {
    const machine = durableSetup({
      events: {
        PAY: { cardToken: "string", amount: "number" },
        CANCEL: {},
      },
    }).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const schemas = (machine as any).schemas?.["xstate-durable"];
    expect(schemas).toBeDefined();
    expect(schemas.events).toEqual({
      PAY: [
        { name: "cardToken", label: "cardToken", type: "text", required: true },
        { name: "amount", label: "amount", type: "number", required: true },
      ],
    });
    // CANCEL has no fields, so it's omitted
    expect(schemas.events.CANCEL).toBeUndefined();
  });

  it("stores input schema on machine.schemas", () => {
    const machine = durableSetup({
      input: { orderId: "string", total: "number" },
    }).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const schemas = (machine as any).schemas?.["xstate-durable"];
    expect(schemas.input).toEqual([
      { name: "orderId", label: "orderId", type: "text", required: true },
      { name: "total", label: "total", type: "number", required: true },
    ]);
  });

  it("works with no events or input (permissive defaults)", () => {
    const machine = durableSetup({}).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });
    expect(machine.id).toBe("test");
    const schemas = (machine as any).schemas?.["xstate-durable"];
    expect(schemas.events).toEqual({});
    expect(schemas.input).toBeUndefined();
  });

  it("stores enum schemas with select type", () => {
    const machine = durableSetup({
      events: {
        SET_STATUS: { status: ["draft", "review", "published"] },
      },
    }).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const schemas = (machine as any).schemas?.["xstate-durable"];
    expect(schemas.events.SET_STATUS).toEqual([
      {
        name: "status",
        label: "status",
        type: "select",
        options: ["draft", "review", "published"],
        required: true,
      },
    ]);
  });

  it("stores label, description, and tags on machine.schemas", () => {
    const machine = durableSetup({
      label: "Order Processing",
      description: "Handles order lifecycle",
      tags: ["orders", "payments"],
    }).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const schemas = (machine as any).schemas?.["xstate-durable"];
    expect(schemas.label).toBe("Order Processing");
    expect(schemas.description).toBe("Handles order lifecycle");
    expect(schemas.tags).toEqual(["orders", "payments"]);
  });

  it("omits metadata fields when not provided", () => {
    const machine = durableSetup({
      events: { PAY: { amount: "number" } },
    }).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const schemas = (machine as any).schemas?.["xstate-durable"];
    expect(schemas.label).toBeUndefined();
    expect(schemas.description).toBeUndefined();
    expect(schemas.tags).toBeUndefined();
  });

  it("stores object-form event schemas on machine.schemas", () => {
    const machine = durableSetup({
      events: {
        PAY: {
          amount: { type: "number", placeholder: "0.00", helpText: "Total" },
        },
      },
    }).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const schemas = (machine as any).schemas?.["xstate-durable"];
    expect(schemas.events.PAY[0].placeholder).toBe("0.00");
    expect(schemas.events.PAY[0].helpText).toBe("Total");
  });

  it("can be used with durableState() markers", () => {
    const machine = durableSetup({
      events: {
        PAY: { amount: "number" },
      },
    }).createMachine({
      id: "order",
      initial: "pending",
      states: {
        pending: {
          ...durableState(),
          on: { PAY: "paid" },
        },
        paid: { type: "final" },
      },
    });

    expect(machine.id).toBe("order");
    // Verify both schemas and durable markers work together
    const schemas = (machine as any).schemas?.["xstate-durable"];
    expect(schemas.events.PAY).toBeDefined();
  });
});

describe("serializeMachineDefinition() with schemas", () => {
  it("includes eventSchemas when machine has event schemas", () => {
    const machine = durableSetup({
      events: {
        PAY: { amount: "number" },
      },
    }).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const definition = serializeMachineDefinition(machine);
    expect(definition.eventSchemas).toEqual({
      PAY: [
        { name: "amount", label: "amount", type: "number", required: true },
      ],
    });
  });

  it("includes inputSchema when machine has input schema", () => {
    const machine = durableSetup({
      input: { orderId: "string" },
    }).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const definition = serializeMachineDefinition(machine);
    expect(definition.inputSchema).toEqual([
      { name: "orderId", label: "orderId", type: "text", required: true },
    ]);
  });

  it("omits schemas when machine has no schemas", () => {
    const machine = setup({}).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const definition = serializeMachineDefinition(machine);
    expect(definition.eventSchemas).toBeUndefined();
    expect(definition.inputSchema).toBeUndefined();
  });

  it("includes label, description, and tags when set", () => {
    const machine = durableSetup({
      label: "Order Processing",
      description: "Handles orders",
      tags: ["orders"],
    }).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const definition = serializeMachineDefinition(machine);
    expect(definition.label).toBe("Order Processing");
    expect(definition.description).toBe("Handles orders");
    expect(definition.tags).toEqual(["orders"]);
  });

  it("omits metadata when not set", () => {
    const machine = durableSetup({}).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const definition = serializeMachineDefinition(machine);
    expect(definition.label).toBeUndefined();
    expect(definition.description).toBeUndefined();
    expect(definition.tags).toBeUndefined();
  });

  it("includes object-form field metadata in inputSchema", () => {
    const machine = durableSetup({
      input: {
        amount: { type: "number", placeholder: "0.00", helpText: "USD" },
      },
    }).createMachine({
      id: "test",
      initial: "idle",
      states: { idle: {} },
    });

    const definition = serializeMachineDefinition(machine);
    expect(definition.inputSchema?.[0]).toMatchObject({
      name: "amount",
      type: "number",
      placeholder: "0.00",
      helpText: "USD",
    });
  });
});
