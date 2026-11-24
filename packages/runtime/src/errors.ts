/**
 * One error type for everything that can go wrong in a way a caller should see.
 * `code` is machine-readable, `status` is the HTTP status the control API uses.
 */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'BUSY'
  | 'NOT_RUNNING'
  | 'HASH_MISMATCH'
  | 'INSUFFICIENT_MEMORY'
  | 'START_TIMEOUT'
  | 'EXITED'
  | 'STOPPED'
  | 'SPAWN_FAILED'
  | 'REQUEST_TIMEOUT'
  | 'APP_ERROR'
  | 'APP_EXITED'
  | 'INTERNAL';

export class PifiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = 500,
    /** For APP_ERROR: the error code the app itself reported. */
    public readonly appCode?: string,
  ) {
    super(message);
    this.name = 'PifiError';
  }
}
