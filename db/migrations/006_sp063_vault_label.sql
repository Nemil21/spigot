-- SP-063: the saved payment method's display label (screens.md §W11 "Visa ••1111" or
-- "PayPal · sb-buyer@…"). Set by `creditTopup` alongside `vault_id` / `vault_kind` from what PayPal
-- returned on the capture (`payment_source.card.brand` + `last_digits`, or the wallet's email).
-- Display only: never card data beyond the brand and last four digits.
ALTER TABLE buyers
  ADD COLUMN vault_label text;
