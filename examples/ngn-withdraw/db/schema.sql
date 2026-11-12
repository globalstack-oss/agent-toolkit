CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  bank_name      TEXT NOT NULL,        -- e.g. "GTBank", "Access Bank"
  bank_code      TEXT NOT NULL,        -- the 3-digit CBN code, e.g. "058"
  account_number TEXT NOT NULL,
  usdc_balance   TEXT NOT NULL         -- the user's USDC balance with us, decimal string with 6 decimals, e.g. "152.384211"
);
