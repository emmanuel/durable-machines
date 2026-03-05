/** Parsed payload from an inbound Twilio SMS webhook. */
export interface TwilioInboundSms {
  /** Sender phone number (E.164 format). */
  From: string;
  /** Twilio phone number that received the message. */
  To: string;
  /** Message text body. */
  Body: string;
  /** Unique Twilio message identifier. */
  MessageSid: string;
  /** Twilio account SID. */
  AccountSid: string;
}
