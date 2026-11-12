import express from 'express';
import { db } from './db';
import { GsError, GsUnknown, Refused } from './globalstack/gs';
import { webhookHandler } from './globalstack/webhooks';
import { startWithdrawal, withdrawals } from './withdrawals';

const app = express();
app.post('/webhooks/globalstack', express.raw({ type: '*/*' }), webhookHandler(db, (e) => withdrawals.onEvent(e)));
app.post('/crypto-withdrawals', express.json(), async (req, res) => {
  try {
    res.status(201).json({ id: await startWithdrawal(req.body) });
  } catch (err) {
    if (err instanceof Refused) res.status(err.status).json({ error: err.message });
    else if (err instanceof GsError || err instanceof GsUnknown) res.status(503).json({ error: 'GlobalStack is unavailable; nothing was charged' });
    else { console.error(err); res.status(500).json({ error: 'internal error' }); }
  }
});
app.get('/crypto-withdrawals/:id', async (req, res) => {
  const p = await withdrawals.get(req.params.id);
  p ? res.json({ id: p.id, status: p.status, failure_reason: p.failure_reason }) : res.status(404).json({ error: 'not found' });
});
app.listen(Number(process.env.PORT ?? 3000), () => withdrawals.start());
