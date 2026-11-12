CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  bank_name      TEXT NOT NULL,        -- e.g. "Capitec Bank"
  branch_code    TEXT NOT NULL,        -- universal branch code, e.g. "470010"
  account_number TEXT NOT NULL,
  usdc_balance   TEXT NOT NULL         -- the user's USDC balance with us, decimal string with 6 decimals
);
