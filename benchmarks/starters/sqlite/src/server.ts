import express from 'express';

const app = express();

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`listening on ${port}`);
});
