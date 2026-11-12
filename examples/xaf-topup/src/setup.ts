import { db } from './db';
import { demoSessions } from './sessions';
import { requestAccessIfNeeded } from './globalstack/catalog';
import { ensureWebhook } from './globalstack/webhooks';
const url = `${String(process.env.PUBLIC_URL).replace(/\/+$/, '')}/webhooks/globalstack`;
const webhook = await ensureWebhook(db, url, ['onramp']);
if (webhook) console.log(`webhook ${webhook} active`);
await requestAccessIfNeeded('XAF', 'CM', 'Mobile money top-ups for our users in Cameroon');
// Demo logins: send one of these as Authorization: Bearer <token>.
for (const [user, token] of Object.entries(await demoSessions(db))) console.log(`session for ${user}: ${token}`);
