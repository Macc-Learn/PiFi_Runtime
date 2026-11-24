/** Plain-language messages for every state the user can see (Phase 3 §9.2). */
import type { ShellErrorCode } from '../core/errors.js';

export const MESSAGES: Record<ShellErrorCode, string> = {
  PI_OFFLINE: 'Your Pi is offline. Make sure it is powered on and connected to the internet. Retrying every 5 seconds…',
  REJECTED: 'The code was not accepted: it may have expired or been used. Run `pifi pair` again.',
  NOT_GENUINE: 'This device could not prove it is your Pi. Nothing was saved.',
  NOT_PAIRED: "This Pi doesn't recognise this phone: it may have been removed. Pair again.",
  UNREACHABLE: "Couldn't connect directly. Some networks block direct connections.",
  SERVER_UNREACHABLE: "Can't reach the PiFi signaling server. Check your internet connection.",
  KEY_MISSING: "This phone's key for this Pi is gone (the browser may have cleared its storage). Pair again.",
  STORAGE_UNAVAILABLE: "This browser won't let PiFi store a key (private browsing?). Open PiFi in a normal tab.",
  DISCONNECTED: 'Not connected to your Pi.',
  TIMEOUT: 'Your Pi did not answer in time.',
  BAD_ANSWER: 'Your Pi could not prove the connection is its own. Pair again to be safe.',
};

export function messageFor(code: string | undefined): string {
  return (code && MESSAGES[code as ShellErrorCode]) || 'Something went wrong.';
}
