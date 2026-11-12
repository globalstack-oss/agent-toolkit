CREATE TABLE sellers (
  id             TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT NOT NULL,        -- E.164, e.g. +254711000001
  address        TEXT NOT NULL,        -- postal address, e.g. "12 Moi Avenue, Nairobi"
  bank_name      TEXT NOT NULL,        -- e.g. "Equity Bank"
  bank_code      TEXT NOT NULL,        -- the 2-digit Kenyan bank code, e.g. "68"
  account_number TEXT NOT NULL
);
