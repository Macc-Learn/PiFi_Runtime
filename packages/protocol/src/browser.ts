/**
 * Browser-safe entry point: `import ... from '@pifi/protocol/browser'`.
 * Nothing in here touches node:* or Buffer, so the shell and @pifi/client can bundle it.
 */
export * from './encoding.js';
export * from './signed.js';
export * from './relay.js';
export * from './wire.js';
export { APP_NAME } from './names.js';
export const DEVICE_ID_REGEX = /^[a-z2-7]{52}$/;
