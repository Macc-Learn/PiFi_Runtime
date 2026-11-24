/** Valid app names (shared by the app protocol, the manifest and the wire protocol). */
export const APP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** A Pi's deviceId (and a phone's phoneId): base32 of SHA-256(SPKI), 52 chars. */
export const DEVICE_ID_REGEX = /^[a-z2-7]{52}$/;
