CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  full_name    TEXT NOT NULL,
  phone        TEXT NOT NULL,                    -- E.164, e.g. +237670000001
  operator     TEXT NOT NULL CHECK (operator IN ('MTN', 'ORANGE')),
  usdc_balance NUMERIC(20, 6) NOT NULL           -- the user's USDC balance with us
);
