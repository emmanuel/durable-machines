import { describe, it, expect } from "vitest";
import {
  machineListPage,
  instanceListPage,
  startInstancePage,
} from "../../../src/dashboard/html.js";
import type { MachineListItem } from "../../../src/dashboard/html.js";
import type { SerializedMachine, FormField } from "@durable-xstate/durable-machine";

function minimalDefinition(overrides: Partial<SerializedMachine> = {}): SerializedMachine {
  return {
    id: "test",
    initial: "idle",
    states: { idle: { path: "idle", type: "atomic" } },
    ...overrides,
  };
}

describe("startInstancePage()", () => {
  it("renders start form with instance ID input", () => {
    const html = startInstancePage("/dash", "order", minimalDefinition(), "/api");
    expect(html).toContain('id="start-form"');
    expect(html).toContain('name="instanceId"');
    expect(html).toContain("required");
  });

  it("renders typed fields when inputSchema is provided", () => {
    const inputSchema: FormField[] = [
      { name: "orderId", label: "Order ID", type: "text", required: true },
      { name: "total", label: "Total", type: "number", required: true, placeholder: "0.00" },
    ];
    const html = startInstancePage("/dash", "order", minimalDefinition({ inputSchema }), "/api");
    expect(html).toContain('data-field="orderId"');
    expect(html).toContain('data-field="total"');
    expect(html).toContain('placeholder="0.00"');
    expect(html).toContain('data-has-schema="true"');
  });

  it("renders textarea fallback when no inputSchema", () => {
    const html = startInstancePage("/dash", "order", minimalDefinition(), "/api");
    expect(html).toContain("<textarea");
    // The form element itself should NOT have data-has-schema="true"
    expect(html).not.toContain('data-has-schema="true"');
  });

  it("renders machine label and description", () => {
    const def = minimalDefinition({
      label: "Order Processing",
      description: "Handles order lifecycle",
    });
    const html = startInstancePage("/dash", "order", def, "/api");
    expect(html).toContain("Order Processing");
    expect(html).toContain("Handles order lifecycle");
  });

  it("falls back to machineId when no label", () => {
    const html = startInstancePage("/dash", "order", minimalDefinition(), "/api");
    expect(html).toContain("order");
  });

  it("renders cancel link back to instance list", () => {
    const html = startInstancePage("/dash", "order", minimalDefinition(), "/api");
    expect(html).toContain('href="/dash/machines/order"');
    expect(html).toContain("Cancel");
  });

  it("renders help text when field has helpText", () => {
    const inputSchema: FormField[] = [
      { name: "amount", label: "Amount", type: "number", required: true, helpText: "Total in USD" },
    ];
    const html = startInstancePage("/dash", "order", minimalDefinition({ inputSchema }), "/api");
    expect(html).toContain("Total in USD");
    expect(html).toContain("help-text");
    expect(html).toContain("aria-describedby");
  });

  it("renders default value on inputs", () => {
    const inputSchema: FormField[] = [
      { name: "priority", label: "Priority", type: "select", options: ["normal", "rush"], required: true, defaultValue: "normal" },
    ];
    const html = startInstancePage("/dash", "order", minimalDefinition({ inputSchema }), "/api");
    expect(html).toContain("selected");
  });

  it("renders field groups as fieldsets", () => {
    const inputSchema: FormField[] = [
      { name: "name", label: "Name", type: "text", required: true, group: "Contact" },
      { name: "email", label: "Email", type: "text", required: true, group: "Contact" },
    ];
    const html = startInstancePage("/dash", "order", minimalDefinition({ inputSchema }), "/api");
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend>Contact</legend>");
  });
});

describe("instanceListPage()", () => {
  it("renders Start New Instance link instead of inline form", () => {
    const html = instanceListPage("/dash", "order", []);
    expect(html).toContain("Start New Instance");
    expect(html).toContain("/dash/machines/order/new");
    expect(html).not.toContain('id="start-form"');
  });
});

describe("machineListPage()", () => {
  it("renders label, description, and tags when provided", () => {
    const items: MachineListItem[] = [
      {
        machineId: "order",
        instanceCount: 5,
        label: "Order Flow",
        description: "End-to-end order processing",
        tags: ["orders", "payments"],
      },
    ];
    const html = machineListPage("/dash", items);
    expect(html).toContain("Order Flow");
    expect(html).toContain("End-to-end order processing");
    expect(html).toContain("orders");
    expect(html).toContain("payments");
    expect(html).toContain("machine-tag");
  });

  it("falls back to machineId when no label", () => {
    const items: MachineListItem[] = [
      { machineId: "order", instanceCount: 3 },
    ];
    const html = machineListPage("/dash", items);
    expect(html).toContain("order");
    // No <span class="machine-label"> in the table body
    expect(html).not.toContain('class="machine-label">');
  });
});
