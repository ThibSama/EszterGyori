/**
 * ESZ-136 — the shared `Retry-After` parser and retry policy.
 *
 * The server contract freezes a 429 `RATE_LIMITED` refusal with
 * `Retry-After` in whole seconds (`contracts.rateLimit.refusal`). Both the
 * admin client and the booking client receive that header, and both must turn
 * it into the *same* bounded wait — never two private parsers that can drift
 * apart — so this module is the single frontend reader of the header.
 *
 * ## What becomes a trusted delay, and what never does
 *
 * Only ASCII whole seconds (`^[0-9]+$`) are recognised: the contract's unit is
 * seconds, so a date-form header, a decimal, a sign or surrounding whitespace
 * is a different language and is refused. The client never blocks on a value
 * it did not parse.
 *
 * `RETRY_AFTER_MAX_SECONDS` bounds what a parsed value may mean. The frozen
 * buckets' largest refusal interval is one emission interval
 * (`retryAfterUnit` note: after a full burst at one instant the refusal is
 * one emission interval); the widest is `booking.create.address`, 3600 s / 5
 * = 720 s. The client therefore honours at most 900 s, so a broken or hostile
 * header can never park a visitor for a long stretch, while every genuine
 * frozen refusal still fits under the cap.
 *
 * A parsed value above the cap is *clamped*, not discarded: the header was
 * valid whole seconds, so it is honoured — but only up to the documented
 * bound. Malformed, negative, non-numeric, absurd (too large to be a safe
 * integer) or missing values return `null`, which every caller treats as "no
 * trusted delay": the refusal is still explicitly rate-limited, but no timer
 * is invented from data that did not parse.
 *
 * ## The gate
 *
 * A trusted delay is stored as an absolute epoch deadline, never a countdown:
 * deadlines survive re-renders, tab switches and clock-agnostic tests. The
 * helpers take `nowEpochMs` explicitly so every transition is provable with
 * injected timestamps and no real sleep. While the gate is closed the UI
 * disables its retry control and shows how long is left; when the deadline
 * passes the control is re-enabled. Nothing here fires a request: the caller
 * retries only when the person asks it to.
 */

/** The longest wait the client ever honours, in whole seconds (see module note). */
export const RETRY_AFTER_MAX_SECONDS = 900;

/**
 * Parses one `Retry-After` header into the bounded whole seconds the client
 * will honour, or `null` when the value is missing or not usable.
 */
export function parseRetryAfterSeconds(raw: string | null): number | null {
  if (raw === null) return null;
  // Whole seconds only. No sign, no decimals, no date form, no whitespace:
  // `Retry-After: 30` is the whole contract, everything else is not it.
  if (!/^[0-9]+$/.test(raw)) return null;
  const seconds = Number(raw);
  // An absurdly long digit string parses to Infinity or a float above the
  // safe-integer range; such a value never becomes a trusted timer.
  if (!Number.isSafeInteger(seconds)) return null;
  return Math.min(seconds, RETRY_AFTER_MAX_SECONDS);
}

/**
 * The epoch (ms) at which a manual retry becomes allowed, or `null` when the
 * refusal carried no trusted delay.
 *
 * `receivedAtEpochMs` is the moment the 429 was observed; the delay is added
 * to it so the deadline is absolute from the start.
 */
export function retryAllowedAtEpochMs(
  receivedAtEpochMs: number,
  retryAfterSeconds: number | null,
): number | null {
  if (retryAfterSeconds === null) return null;
  return receivedAtEpochMs + retryAfterSeconds * 1000;
}

/** Whether a trusted delay currently prevents an immediate manual retry. */
export function isRetryBlocked(
  retryAllowedAtEpochMs: number | null,
  nowEpochMs: number,
): boolean {
  return retryAllowedAtEpochMs !== null && nowEpochMs < retryAllowedAtEpochMs;
}

/**
 * Whole seconds left before a manual retry is allowed, or `null` when there
 * is no trusted delay. `0` means the wait is over; never negative.
 */
export function retryWaitSeconds(
  retryAllowedAtEpochMs: number | null,
  nowEpochMs: number,
): number | null {
  if (retryAllowedAtEpochMs === null) return null;
  const remainingMs = retryAllowedAtEpochMs - nowEpochMs;
  return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1000);
}

/**
 * The exact French copy shown while a trusted delay blocks the retry control,
 * or `null` when the control may be used (no delay, or the wait is over).
 */
export function retryWaitLabel(
  retryAllowedAtEpochMs: number | null,
  nowEpochMs: number,
): string | null {
  const seconds = retryWaitSeconds(retryAllowedAtEpochMs, nowEpochMs);
  if (seconds === null || seconds <= 0) return null;
  // Minutes round up so the label never promises an earlier retry than the
  // deadline it announces.
  if (seconds < 60) return `Réessayez dans ${seconds} s`;
  return `Réessayez dans ${Math.ceil(seconds / 60)} min`;
}
