export const Q_REGISTER_DEFINITION = {
  name: "dm_reg_definition",
  text: `SELECT dm_register_definition($1, $2)`,
} as const;

export const Q_NATIVE_CREATE_INSTANCE = {
  name: "dm_native_create_instance",
  text: `SELECT dm_create_instance($1, $2, $3, $4)`,
} as const;

export const Q_NATIVE_PROCESS_EVENTS = {
  name: "dm_native_process_events",
  text: `SELECT dm_process_events($1, $2)`,
} as const;

export const Q_SEND_EVENT = {
  name: "dm_send_event",
  text: `SELECT dm_send_event($1, $2, $3, $4)`,
} as const;

export const Q_GET_DEFINITION = {
  name: "dm_get_definition",
  text: `SELECT definition FROM machine_definitions WHERE machine_name = $1`,
} as const;
