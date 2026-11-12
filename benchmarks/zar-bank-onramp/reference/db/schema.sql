CREATE TABLE businesses (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  registration_number TEXT NOT NULL,
  usdc_balance        TEXT NOT NULL    -- the business's USDC balance with us, decimal string with 6 decimals
);
