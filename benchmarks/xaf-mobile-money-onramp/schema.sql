CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  full_name    TEXT NOT NULL,
  phone        TEXT NOT NULL,          -- E.164, e.g. +237670000001
  usdc_balance TEXT NOT NULL           -- the user's USDC balance with us, decimal string with 6 decimals
);
