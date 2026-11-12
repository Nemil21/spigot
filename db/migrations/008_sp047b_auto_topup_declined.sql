-- SP-047b: when the saved method last declined a vault top-up (`failVaultTopupTx` sets it along with
-- `auto_topup_enabled = false`). W11 shows "PayPal declined the saved card. Auto top-up is off until
-- you update it." while it is set and auto top-up is off; `PUT /api/buyer/auto-topup` clears it.
ALTER TABLE buyers
  ADD COLUMN auto_topup_declined_at timestamptz;
