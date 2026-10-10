export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Placeholder we send to Flutterwave when the buyer left the email field empty. */
export function placeholderEmail(orderId: string, publicUrl: string): string {
  let host = 'storelint.embracetech.org';
  try {
    host = new URL(publicUrl).hostname || host;
  } catch {
    /* keep default */
  }
  return `orders+${orderId}@${host}`;
}

export function isPlaceholderEmail(email: string): boolean {
  return /^orders\+sl_[0-9a-f]+@/i.test(email);
}

/** A syntactically valid address that belongs to a person (not our own checkout placeholder). */
export function isDeliverableEmail(email: string | null | undefined): email is string {
  // The extra character check keeps address-list syntax (commas, angle brackets, quotes) out of mail headers.
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email) && !/[,;<>()"\\[\]]/.test(email) && !isPlaceholderEmail(email);
}
