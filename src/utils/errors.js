/**
 * An error whose message is safe and useful to show to the Discord user.
 * Anything that is *not* a UserError is treated as an internal error: logged, and replaced by a generic message.
 */
export class UserError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'UserError';
  }
}

/** Error raised when a track cannot be extracted or streamed. `reason` is user-facing. */
export class TrackError extends UserError {
  constructor(reason, { code = 'UNKNOWN', retryable = false, cause } = {}) {
    super(reason, { cause });
    this.name = 'TrackError';
    this.code = code;
    this.retryable = retryable;
  }
}
