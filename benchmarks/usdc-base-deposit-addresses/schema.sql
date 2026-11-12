CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  full_name    TEXT NOT NULL,
  usdc_balance TEXT NOT NULL           -- the user's USDC balance with us, decimal string with 6 decimals
);
