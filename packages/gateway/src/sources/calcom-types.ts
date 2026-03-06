/** Cal.com webhook event. */
export interface CalcomWebhookEvent {
  /** The trigger event type (e.g. `"BOOKING_CREATED"`, `"BOOKING_CANCELLED"`). */
  triggerEvent: string;
  /** ISO-8601 timestamp of when the webhook was fired. */
  createdAt: string;
  /** Event-specific payload containing booking details, attendees, etc. */
  payload: CalcomBookingPayload;
}

/** Booking payload included in most Cal.com webhook events. */
export interface CalcomBookingPayload {
  /** Booking title. */
  title?: string;
  /** Event type slug. */
  type?: string;
  /** Event description. */
  description?: string | null;
  /** ISO-8601 start time. */
  startTime?: string;
  /** ISO-8601 end time. */
  endTime?: string;
  /** Unique booking UID. */
  uid?: string;
  /** Numeric booking ID. */
  bookingId?: number;
  /** Booking status (e.g. `"ACCEPTED"`, `"PENDING"`, `"CANCELLED"`). */
  status?: string;
  /** Location of the meeting (URL, address, or phone). */
  location?: string;
  /** Organizer details. */
  organizer?: CalcomPerson;
  /** List of attendees. */
  attendees?: CalcomPerson[];
  /** Additional payload fields. */
  [key: string]: unknown;
}

/** A person (organizer or attendee) in a Cal.com booking. */
export interface CalcomPerson {
  /** Display name. */
  name?: string;
  /** Email address. */
  email?: string;
  /** IANA timezone (e.g. `"America/New_York"`). */
  timeZone?: string;
  /** Locale code (e.g. `"en"`). */
  language?: string;
}
