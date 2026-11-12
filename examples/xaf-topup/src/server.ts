// Who is calling comes from the login: currentUser() reads a token from the sessions table, which stands in for
// your app's real login. Never take the user from the request body, and only show a payment to its owner.
import express from 'express';
import { db } from './db';
import { GsError, GsUnknown, Refused } from './globalstack/gs';
import { idempotencyKey } from './idempotency';
import { currentUser } from './sessions';
import { webhookHandler } from './globalstack/webhooks';
import { startTopup, topups, view } from './topups';

const app = express();
app.post('/webhooks/globalstack', express.raw({ type: '*/*' }), webhookHandler(db, (e) => topups.onEvent(e)));
app.post('/topups', express.json(), async (req, res) => {
  try {
    const { replayed, result } = await startTopup(await currentUser(db, req), req.body, idempotencyKey(req.get('idempotency-key')));
    res.status(replayed ? 200 : 201).json(result);
  } catch (err) {
    if (err instanceof Refused) res.status(err.status).json({ error: err.message });
    else if (err instanceof GsError || err instanceof GsUnknown) res.status(503).json({ error: 'GlobalStack is unavailable; nothing was charged' });
    else { console.error(err); res.status(500).json({ error: 'internal error' }); }
  }
});
app.get('/topups/:id', async (req, res) => {
  try {
    const v = await view(await currentUser(db, req), req.params.id);
    v ? res.json(v) : res.status(404).json({ error: 'not found' });
  } catch (err) {
    if (err instanceof Refused) res.status(err.status).json({ error: err.message });
    else { console.error(err); res.status(500).json({ error: 'internal error' }); }
  }
});
// The poller resumes collections after a crash and covers lost webhooks. GLOBALSTACK_POLL_MS shortens it in tests.
// Listens on this machine only. HOST=0.0.0.0 opens it to the network, e.g. inside a container.
app.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? '127.0.0.1', () => topups.startPolling(Number(process.env.GLOBALSTACK_POLL_MS ?? 60_000)));
