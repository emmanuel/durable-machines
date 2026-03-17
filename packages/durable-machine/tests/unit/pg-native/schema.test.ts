import { describe, it, expect } from "vitest";
import { NATIVE_SCHEMA_SQL } from "../../../src/pg-native/schema.js";

describe("NATIVE_SCHEMA_SQL", () => {
  // ── Table & column additions ──────────────────────────────────────────

  it("creates machine_definitions table", () => {
    expect(NATIVE_SCHEMA_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS machine_definitions",
    );
  });

  it("adds definition_override column to machine_instances", () => {
    expect(NATIVE_SCHEMA_SQL).toContain(
      "ALTER TABLE machine_instances ADD COLUMN IF NOT EXISTS definition_override",
    );
  });

  // ── Function declarations ─────────────────────────────────────────────

  it("declares dm_register_definition function", () => {
    expect(NATIVE_SCHEMA_SQL).toContain(
      "CREATE OR REPLACE FUNCTION dm_register_definition",
    );
  });

  it("declares dm_create_instance function", () => {
    expect(NATIVE_SCHEMA_SQL).toContain(
      "CREATE OR REPLACE FUNCTION dm_create_instance",
    );
  });

  it("declares dm_process_events function", () => {
    expect(NATIVE_SCHEMA_SQL).toContain(
      "CREATE OR REPLACE FUNCTION dm_process_events",
    );
  });

  // ── Function signatures ───────────────────────────────────────────────

  it("dm_register_definition accepts TEXT and JSONB parameters", () => {
    // Match the parameter list (ignoring whitespace differences)
    expect(NATIVE_SCHEMA_SQL).toMatch(
      /dm_register_definition\(\s*p_machine_name\s+TEXT,\s*p_definition\s+JSONB\s*\)/s,
    );
  });

  it("dm_create_instance accepts UUID, TEXT, JSONB, and optional JSONB", () => {
    expect(NATIVE_SCHEMA_SQL).toMatch(
      /dm_create_instance\(\s*p_id\s+UUID,\s*p_machine_name\s+TEXT,\s*p_input\s+JSONB,\s*p_definition_override\s+JSONB\s+DEFAULT\s+NULL\s*\)/s,
    );
  });

  it("dm_process_events accepts UUID and optional INTEGER limit", () => {
    expect(NATIVE_SCHEMA_SQL).toMatch(
      /dm_process_events\(\s*p_instance_id\s+UUID,\s*p_limit\s+INTEGER\s+DEFAULT\s+50\s*\)/s,
    );
  });

  // ── Schema is additive (no destructive operations) ────────────────────

  it("does not contain DROP TABLE statements", () => {
    expect(NATIVE_SCHEMA_SQL).not.toMatch(/DROP\s+TABLE/i);
  });

  it("does not contain ALTER TABLE DROP on base schema tables", () => {
    // Ensure we don't drop columns from machine_instances or event_log
    expect(NATIVE_SCHEMA_SQL).not.toMatch(
      /ALTER\s+TABLE\s+(machine_instances|event_log|transition_log|effect_outbox)\s+DROP/i,
    );
  });

  // ── Uses statecraft extension ─────────────────────────────────────────

  it("uses sc_create Rust extension call", () => {
    expect(NATIVE_SCHEMA_SQL).toContain("sc_create(");
  });

  it("uses sc_send Rust extension call", () => {
    expect(NATIVE_SCHEMA_SQL).toContain("sc_send(");
  });

  // ── Locking strategy ─────────────────────────────────────────────────

  it("uses FOR NO KEY UPDATE for instance locking", () => {
    expect(NATIVE_SCHEMA_SQL).toContain("FOR NO KEY UPDATE");
  });

  it("does not use SKIP LOCKED", () => {
    expect(NATIVE_SCHEMA_SQL).not.toMatch(/SKIP\s+LOCKED/i);
  });

  // ── UNNEST batch insert pattern ──────────────────────────────────────

  it("uses UNNEST batch insert pattern for effects", () => {
    expect(NATIVE_SCHEMA_SQL).toMatch(
      /INSERT\s+INTO\s+effect_outbox\b.*?SELECT\s+\*\s+FROM\s+UNNEST\(/s,
    );
  });

  it("uses UNNEST batch insert pattern for transitions", () => {
    expect(NATIVE_SCHEMA_SQL).toMatch(
      /INSERT\s+INTO\s+transition_log\b.*?SELECT\s+\*\s+FROM\s+UNNEST\(/s,
    );
  });
});
