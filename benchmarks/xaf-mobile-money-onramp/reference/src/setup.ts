import { db } from './db';
import { requestAccessIfNeeded } from './globalstack/catalog';
import { ensureWebhook } from './globalstack/webhooks';
const url = `${String(process.env.PUBLIC_URL).replace(/\/+$/, '')}/webhooks/globalstack`;
console.log(`webhook ${await ensureWebhook(db, url, ['onramp'])} active`);
await requestAccessIfNeeded('XAF', 'CM', 'Mobile money top-ups for our users in Cameroon');
