-- Fee accounting: store entry fee at open, total fees at close
ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_fee NUMERIC(14,4);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS fees_paid NUMERIC(14,4);
