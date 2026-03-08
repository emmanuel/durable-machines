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

/**
 * Schema notation for a single field. Maps to TypeScript types and form controls.
 *
 * - `"string"` → `string` → text input
 * - `"number"` → `number` → number input
 * - `"boolean"` → `boolean` → checkbox
 * - `"date"` → `string` → date input
 * - `"string?"`, `"number?"` etc. → optional field
 * - `["a", "b", "c"]` → `"a" | "b" | "c"` → select dropdown
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
  | readonly string[];

/** Maps event type names to their field schemas. */
export type EventSchemaMap = Record<string, Record<string, FieldSchema>>;

// ── Type Resolution ────────────────────────────────────────────────────────

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
                  : never;

/** Resolve an object of field schemas to a typed object with required/optional keys. */
export type ResolveFields<T extends Record<string, FieldSchema>> = {
  [K in keyof T as T[K] extends `${string}?` ? never : K]: ResolveField<T[K]>;
} & {
  [K in keyof T as T[K] extends `${string}?` ? K : never]?: ResolveField<
    T[K]
  >;
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
    if (Array.isArray(fieldSchema)) {
      return {
        name,
        label: name,
        type: "select" as const,
        options: [...fieldSchema],
        required: true,
      };
    }
    // After the Array.isArray guard, fieldSchema is a string literal
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
  } = {} as any,
): SetupReturn<
  MachineContext,
  EventsFromSchema<TEvents>,
  TActors,
  {},
  {},
  {},
  never,
  string,
  InputFromSchema<TInputSchema>,
  NonReducibleUnknown,
  EventObject,
  MetaObject
> {
  const { events, input, actors } = options;

  const schemas = {
    [SCHEMA_KEY]: {
      events: events ? eventSchemasToFormFields(events) : {},
      input: input ? schemaToFormFields(input) : undefined,
    },
  };

  // Internal cast: TypeScript can't verify deferred conditional types
  // satisfy setup()'s constraints in a generic context, but they resolve
  // correctly at concrete call sites.
  return setup({
    schemas,
    actors,
    types: {} as {
      events: EventsFromSchema<TEvents>;
      input: InputFromSchema<TInputSchema>;
    },
  } as any) as any;
}
