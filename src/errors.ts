/**
 * Errors raised by `MarketClient`. `AvoSdkError` is structured (status +
 * code + message) and carries the HTTP context so callers can branch on
 * status / code without re-parsing the response. `AvoTransportError`
 * wraps low-level fetch failures (DNS, connection refused, non-JSON body).
 */

export class AvoSdkError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(opts: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  }) {
    super(opts.message);
    this.name = 'AvoSdkError';
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }
}

/** Thrown for network-layer failures (fetch threw, non-JSON body, etc.). */
export class AvoTransportError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AvoTransportError';
    this.cause = cause;
  }
}

/** Envelope shape some routes return on non-2xx responses. The HTTP base
 *  parses either this shape or a flat `{ code, message, details }` shape. */
export interface ServiceErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
