CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  bank_name      TEXT NOT NULL,        -- e.g. "Equity Bank", "Kenya Commercial Bank"
  bank_code      TEXT NOT NULL,        -- the 2-digit Kenyan bank code, e.g. "68"
  account_number TEXT NOT NULL,
  usdc_balance   TEXT NOT NULL         -- the user's USDC balance with us, decimal string with 6 decimals
);
