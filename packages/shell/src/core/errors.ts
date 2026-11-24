/**
 * Every failure the UI knows how to explain (Phase 3 §9.2). The UI maps codes
 * to plain-language messages; nothing here is shown raw to the user.
 */
export type ShellErrorCode =
  | 'PI_OFFLINE'          // the Pi isn't connected to the signaling server
  | 'REJECTED'            // pairing code not accepted (expired / used / wrong)
  | 'NOT_GENUINE'         // the "Pi" could not prove it holds the key behind the QR's device ID
  | 'NOT_PAIRED'          // the Pi doesn't recognise this phone (revoked)
  | 'UNREACHABLE'         // no direct connection could be made
  | 'SERVER_UNREACHABLE'  // signaling server down / blocked
  | 'KEY_MISSING'         // Pi record exists but its key is gone
  | 'STORAGE_UNAVAILABLE' // e.g. private browsing
  | 'DISCONNECTED'        // request made while not connected
  | 'TIMEOUT'
  | 'BAD_ANSWER';         // the Pi's session answer didn't verify

export class ShellError extends Error {
  constructor(readonly code: ShellErrorCode, message: string = code) {
    super(message);
    this.name = 'ShellError';
  }
}

export const isShellError = (e: unknown, code?: ShellErrorCode): e is ShellError =>
  e instanceof ShellError && (code === undefined || e.code === code);
