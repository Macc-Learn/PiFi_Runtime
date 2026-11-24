/**
 * Browser-safe entry point: `import ... from '@pifi/protocol/browser'`.
 * Nothing in here touches node:* or Buffer, so the shell and @pifi/client can bundle it.
 */
export * from './encoding.js';
export * from './signed.js';
export * from './relay.js';
export * from './wire.js';
export * from './signaling.js';
export * from './port.js';
export { APP_NAME, DEVICE_ID_REGEX } from './names.js';
