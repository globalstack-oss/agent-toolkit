import express from 'express';
import { db } from './db';
import { GsError, GsUnknown, Refused } from './globalstack/gs';
import { webhookHandler } from './globalstack/webhooks';
import { cashouts, startCashout, view } from './cashouts';

const app = express();
app.post('/webhooks/globalstack', express.raw({ type: '*/*' }), webhookHandler(db, (e) => cashouts.onEvent(e)));
app.post('/cashouts', express.json(), async (req, res) => {
  try {
    res.status(201).json(await startCashout(req.body));
  } catch (err) {
    if (err instanceof Refused) res.status(err.status).json({ error: err.message });
    else if (err instanceof GsError || err instanceof GsUnknown) res.status(503).json({ error: 'GlobalStack is unavailable; nothing was charged' });
    else { console.error(err); res.status(500).json({ error: 'internal error' }); }
  }
});
app.get('/cashouts/:id', async (req, res) => {
  const v = await view(req.params.id);
  v ? res.json(v) : res.status(404).json({ error: 'not found' });
});
app.listen(Number(process.env.PORT ?? 3000), () => cashouts.start());
