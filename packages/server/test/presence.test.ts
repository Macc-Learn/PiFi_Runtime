import { InMemoryPresenceStore } from '../src/presence/InMemoryPresenceStore.js';
import { presenceContract } from './presenceContract.js';

presenceContract('InMemoryPresenceStore', () => new InMemoryPresenceStore());
