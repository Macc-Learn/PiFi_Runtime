/**
 * Pi side of pairing (Phase 3 §4.2), carried inside signaling relays.
 *
 *   phone -> Pi  pair.request { phoneSpki, proof, challenge, label }
 *   Pi -> phone  pair.accept  { piSpki, signature }      on success
 *                pair.reject  { reason: "rejected" }      on ANY failure
 *
 * `proof` = HMAC(secret, "pifi-pair-v1" || deviceId || phoneSpki) shows the phone
 * scanned our QR (the secret never travels). `signature` covers the phone's own
 * fresh `challenge`, so the phone knows it talks to the real key holder, not
 * a replay of an older accept.
 *
 * Every failure returns the identical body, so a prober learns nothing about why.
 */
import {
  b64urlDecode, b64urlEncode, importP256Spki, PAIR_ACCEPT_CONTEXT, phoneIdFromSpki, signedMessage, utf8,
  type PairRequest, type PiToPhoneBody,
} from '@pifi/protocol';
import type { Identity } from './identity.js';
import type { Logger } from './logger.js';
import type { PairingManager } from './pairing.js';
import type { PairedStore } from './pairedStore.js';

const REJECT: PiToPhoneBody = { k: 'pair.reject', reason: 'rejected' };

/** Labels end up in a UI and a JSON file: printable characters only. */
function cleanLabel(label: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = label.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim().slice(0, 40);
  return cleaned || 'My phone';
}

export class PairHandler {
  constructor(
    private readonly identity: Identity,
    private readonly pairing: PairingManager,
    private readonly store: PairedStore,
    private readonly log: Logger,
  ) {}

  handle(req: PairRequest): PiToPhoneBody {
    const phoneSpki = b64urlDecode(req.phoneSpki);
    const proof = b64urlDecode(req.proof);
    const challenge = b64urlDecode(req.challenge);
    if (!phoneSpki || !proof || !challenge || challenge.length !== 16) return this.fail('malformed request');
    // A bad key or a full store still counts against the code, so they can't be used to probe for free.
    if (!importP256Spki(phoneSpki)) return this.fail('invalid phone key');
    if (this.store.isFull()) return this.fail('paired store is full');
    if (!this.pairing.verifyProof(this.identity.deviceId, phoneSpki, proof)) return this.fail('bad or no active pairing code', false);

    // verifyProof() succeeded and has already burned the code.
    const phoneId = phoneIdFromSpki(phoneSpki);
    if (!this.store.add({ phoneId, spki: req.phoneSpki, label: cleanLabel(req.label) })) return this.fail('paired store is full', false);

    const signature = this.identity.sign(signedMessage(PAIR_ACCEPT_CONTEXT, utf8(this.identity.deviceId), phoneSpki, challenge));
    return { k: 'pair.accept', piSpki: b64urlEncode(this.identity.publicKeyDer), signature: b64urlEncode(signature) };
  }

  private fail(why: string, countIt = true): PiToPhoneBody {
    if (countIt) this.pairing.noteFailure();
    this.log.warn(`pairing attempt rejected (${why})`);
    return REJECT;
  }
}
