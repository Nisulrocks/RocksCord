/** Transport-agnostic email shapes, in their own module so drivers do not import the registry. */

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Always sent alongside the HTML part. */
  text: string;
}

export interface EmailDriver {
  readonly name: string;
  /**
   * Whether this transport can actually reach a mailbox.
   *
   * The console driver cannot, and that single fact decides whether email verification is
   * enforced: demanding a click on a link that was only ever printed to a log file would
   * lock people out of an offline install permanently.
   */
  readonly canDeliver: boolean;
  send(message: EmailMessage): Promise<void>;
}
