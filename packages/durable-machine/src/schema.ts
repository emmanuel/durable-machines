/**
 * Schema-driven setup for durable XState machines.
 *
 * `durableSetup()` wraps XState's `setup()` to provide:
 * - String-literal schema notation for events and input
 * - Runtime schema storage on `machine.schemas` for dashboard form rendering
 * - Full TypeScript type inference from schema declarations
 */
import { setup } from "xstate";
import type {
  MachineContext,
  AnyEventObject,
  EventObject,
  UnknownActorLogic,
  NonReducibleUnknown,
  MetaObject,
} from "xstate";
import type { SetupReturn } from "xstate";
import type { FormField } from "./types.js";

const SCHEMA_KEY = "xstate-durable";

// ── Schema Notation Types ──────────────────────────────────────────────────

/** Base type names used in both shorthand and object-form schemas. */
type BaseFieldType = "string" | "number" | "boolean" | "date";

/** Object-form field schema for richer metadata (placeholder, helpText, etc.). */
export interface ObjectFieldSchema {
  type: BaseFieldType | "select";
  label?: string;
  placeholder?: string;
  helpText?: string;
  defaultValue?: string;
  group?: string;
  options?: readonly string[];
  required?: boolean;
}

/**
 * Schema notation for a single field. Maps to TypeScript types and form controls.
 *
 * String shorthand:
 * - `"string"` → `string` → text input
 * - `"number"` → `number` → number input
 * - `"boolean"` → `boolean` → checkbox
 * - `"date"` → `string` → date input
 * - `"string?"`, `"number?"` etc. → optional field
 * - `["a", "b", "c"]` → `"a" | "b" | "c"` → select dropdown
 *
 * Object form (opt-in for richer metadata):
 * - `{ type: "number", label: "Amount ($)", placeholder: "0.00" }`
 */
export type FieldSchema =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "string?"
  | "number?"
  | "boolean?"
  | "date?"
  | readonly string[]
  | ObjectFieldSchema;

/** Maps event type names to their field schemas. */
export type EventSchemaMap = Record<string, Record<string, FieldSchema>>;

// ── Type Resolution ────────────────────────────────────────────────────────

/** Resolve an ObjectFieldSchema to its TypeScript type. */
type ResolveObjectField<T extends ObjectFieldSchema> =
  T["type"] extends "string" ? string :
  T["type"] extends "number" ? number :
  T["type"] extends "boolean" ? boolean :
  T["type"] extends "date" ? string :
  T["type"] extends "select" ? (T["options"] extends readonly string[] ? T["options"][number] : string) :
  never;

/** Resolve a single field schema to its TypeScript type. */
type ResolveField<T extends FieldSchema> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : T extends "date"
        ? string
        : T extends "string?"
          ? string | undefined
          : T extends "number?"
            ? number | undefined
            : T extends "boolean?"
              ? boolean | undefined
              : T extends "date?"
                ? string | undefined
                : T extends readonly string[]
                  ? T[number]
                  : T extends ObjectFieldSchema
                    ? ResolveObjectField<T>
                    : never;

/** Check if a field schema is optional. */
type IsOptionalField<T extends FieldSchema> =
  T extends `${string}?` ? true :
  T extends ObjectFieldSchema ? (T["required"] extends false ? true : false) :
  false;

/** Resolve an object of field schemas to a typed object with required/optional keys. */
export type ResolveFields<T extends Record<string, FieldSchema>> = {
  [K in keyof T as IsOptionalField<T[K]> extends true ? never : K]: ResolveField<T[K]>;
} & {
  [K in keyof T as IsOptionalField<T[K]> extends true ? K : never]?: ResolveField<T[K]>;
};

/** Resolve an event schema map to an XState event union type. */
export type ResolveEvents<T extends EventSchemaMap> = {
  [K in keyof T & string]: { type: K } & ResolveFields<T[K]>;
}[keyof T & string];

/** Derive event type: use schema if provided, otherwise allow any event. */
type EventsFromSchema<T extends EventSchemaMap> = keyof T extends never
  ? AnyEventObject
  : ResolveEvents<T>;

/** Derive input type: use schema if provided, otherwise allow any input. */
type InputFromSchema<T extends Record<string, FieldSchema>> =
  keyof T extends never ? NonReducibleUnknown : ResolveFields<T>;

// ── Runtime Schema Conversion ──────────────────────────────────────────────

const FIELD_TYPE_MAP: Record<string, FormField["type"]> = {
  string: "text",
  number: "number",
  boolean: "checkbox",
  date: "date",
};

/**
 * Convert a field schema record to an array of FormField descriptors.
 * Used at runtime to provide form metadata for the dashboard.
 */
export function schemaToFormFields(
  schema: Record<string, FieldSchema>,
): FormField[] {
  return Object.entries(schema).map(([name, fieldSchema]) => {
    // Array shorthand: ["a", "b", "c"] → select
    if (Array.isArray(fieldSchema)) {
      return {
        name,
        label: name,
        type: "select" as const,
        options: [...fieldSchema],
        required: true,
      };
    }

    // Object form: { type: "number", placeholder: "0.00", ... }
    if (typeof fieldSchema === "object" && fieldSchema !== null) {
      const obj = fieldSchema as ObjectFieldSchema;
      const formType = obj.type === "select" ? "select" : (FIELD_TYPE_MAP[obj.type] ?? "text");
      const field: FormField = {
        name,
        label: obj.label ?? name,
        type: formType as FormField["type"],
        required: obj.required !== false,
      };
      if (obj.type === "select" && obj.options) field.options = [...obj.options];
      if (obj.placeholder) field.placeholder = obj.placeholder;
      if (obj.helpText) field.helpText = obj.helpText;
      if (obj.defaultValue) field.defaultValue = obj.defaultValue;
      if (obj.group) field.group = obj.group;
      return field;
    }

    // String shorthand: "string", "number?", etc.
    const str = fieldSchema as string;
    const isOptional = str.endsWith("?");
    const base = isOptional ? str.slice(0, -1) : str;
    return {
      name,
      label: name,
      type: (FIELD_TYPE_MAP[base] ?? "text") as FormField["type"],
      required: !isOptional,
    };
  });
}

function eventSchemasToFormFields(
  events: EventSchemaMap,
): Record<string, FormField[]> {
  const result: Record<string, FormField[]> = {};
  for (const [eventType, fields] of Object.entries(events)) {
    if (Object.keys(fields).length > 0) {
      result[eventType] = schemaToFormFields(fields);
    }
  }
  return result;
}

// ── durableSetup() ─────────────────────────────────────────────────────────

/**
 * Wraps XState's `setup()` with schema-driven event and input type inference.
 * Stores schemas at runtime on `machine.schemas["xstate-durable"]` for
 * dashboard form rendering.
 *
 * @example
 * ```ts
 * const machine = durableSetup({
 *   events: {
 *     PAY: { cardToken: "string", amount: "number" },
 *     UPDATE_STATUS: { status: ["draft", "review", "published"] },
 *     CANCEL: {},
 *   },
 *   input: { orderId: "string", total: "number" },
 * }).createMachine({
 *   id: "order",
 *   context: ({ input }) => ({ orderId: input.orderId, total: input.total }),
 *   // ...
 * });
 * ```
 */
export function durableSetup<
  const TEvents extends EventSchemaMap = {},
  const TInputSchema extends Record<string, FieldSchema> = {},
  TActors extends Record<string, UnknownActorLogic> = {},
>(
  options: {
    events?: TEvents;
    input?: TInputSchema;
    actors?: { [K in keyof TActors]: TActors[K] };
    guards?: Record<string, (...args: any[]) => boolean>;
    delays?: Record<string, number | ((...args: any[]) => number)>;
    label?: string;
    description?: string;
    tags?: string[];
  } = {} as any,
): SetupReturn<
  MachineContext,
  EventsFromSchema<TEvents>,
  TActors,
  {},
  {},
  Record<string, any>,
  string,
  string,
  InputFromSchema<TInputSchema>,
  NonReducibleUnknown,
  EventObject,
  MetaObject
> {
  const { events, input, actors, guards, delays, label, description, tags } = options;

  const schemas = {
    [SCHEMA_KEY]: {
      events: events ? eventSchemasToFormFields(events) : {},
      input: input ? schemaToFormFields(input) : undefined,
      ...(label != null && { label }),
      ...(description != null && { description }),
      ...(tags != null && { tags }),
    },
  };

  // Internal cast: TypeScript can't verify deferred conditional types
  // satisfy setup()'s constraints in a generic context, but they resolve
  // correctly at concrete call sites.
  return setup({
    schemas,
    actors,
    guards,
    delays,
    types: {} as {
      events: EventsFromSchema<TEvents>;
      input: InputFromSchema<TInputSchema>;
    },
  } as any) as any;
}
