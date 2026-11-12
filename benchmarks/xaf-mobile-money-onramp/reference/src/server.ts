import express from 'express';
import { db } from './db';
import { GsError, GsUnknown, Refused } from './globalstack/gs';
import { webhookHandler } from './globalstack/webhooks';
import { startTopup, topups } from './topups';

const app = express();
app.post('/webhooks/globalstack', express.raw({ type: '*/*' }), webhookHandler(db, (e) => topups.onEvent(e)));
app.post('/topups', express.json(), async (req, res) => {
  try {
    res.status(201).json(await startTopup(req.body));
  } catch (err) {
    if (err instanceof Refused) res.status(err.status).json({ error: err.message });
    else if (err instanceof GsError || err instanceof GsUnknown) res.status(503).json({ error: 'GlobalStack is unavailable; nothing was charged' });
    else { console.error(err); res.status(500).json({ error: 'internal error' }); }
  }
});
app.listen(Number(process.env.PORT ?? 3000), () => topups.startPolling());
