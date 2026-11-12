import { db } from './db';
import { ensureWebhook } from './globalstack/webhooks';
const url = `${String(process.env.PUBLIC_URL).replace(/\/+$/, '')}/webhooks/globalstack`;
console.log(`webhook ${await ensureWebhook(db, url, ['offramp', 'kyc'])} active`);
