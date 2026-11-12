import express from 'express';
import { db } from './db';
import { createDeposits } from './globalstack/deposits';
import { GsError, GsUnknown, Refused } from './globalstack/gs';
import { fromUnits, toUnits } from './globalstack/money';
import { webhookHandler } from './globalstack/webhooks';

const deposits = createDeposits(db, {
  walletId: process.env.GLOBALSTACK_WALLET_ID!,
  network: 'base',
  userExists: async (id) => !!(await db.get('SELECT id FROM users WHERE id = ?', id)),
  onCredited: async (userId, amount, _txn, tx) => {
    const b = toUnits((await tx.get('SELECT usdc_balance FROM users WHERE id = ?', userId)).usdc_balance);
    await tx.run('UPDATE users SET usdc_balance = ? WHERE id = ?', fromUnits(b + toUnits(amount)), userId);
  },
});

const app = express();
app.post('/webhooks/globalstack', express.raw({ type: '*/*' }), webhookHandler(db, (e) => deposits.onEvent(e)));
app.post('/deposit-addresses', express.json(), async (req, res) => {
  try {
    res.status(201).json(await deposits.addressFor(req.body?.user_id));
  } catch (err) {
    if (err instanceof Refused) res.status(err.status).json({ error: err.message });
    else if (err instanceof GsError || err instanceof GsUnknown) res.status(503).json({ error: 'GlobalStack is unavailable; try again shortly' });
    else { console.error(err); res.status(500).json({ error: 'internal error' }); }
  }
});
app.listen(Number(process.env.PORT ?? 3000), () => deposits.startPolling());
