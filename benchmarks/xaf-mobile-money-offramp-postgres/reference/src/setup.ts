import { db } from './db';
import { requestAccessIfNeeded } from './globalstack/catalog';
import { ensureWebhook } from './globalstack/webhooks';
const url = `${String(process.env.PUBLIC_URL).replace(/\/+$/, '')}/webhooks/globalstack`;
console.log(`webhook ${await ensureWebhook(db, url, ['offramp'])} active`);
await requestAccessIfNeeded('XAF', 'CM', 'Mobile money payouts to our users in Cameroon (MTN, Orange)');
process.exit(0);
