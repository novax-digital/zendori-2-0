-- Zendori v2 — 0044: e-mail asking a customer to set up billing (Stripe)
--
-- Owner request 2026-11-26: a customer whose billing is switched to Stripe
-- learns about it — until now the new block under Einstellungen → Abrechnung
-- simply appeared, and nobody was told.
--
-- When the operator enables Stripe billing (or asks again later), the worker
-- sends ONE e-mail to the owners and admins of the organization, with a link to
-- the billing page. The request and its outcome live on the row of the Stripe
-- mode it was made in:
--
--   billing_stripe_customers.setup_mail_requested_at   set by the app, taken by the worker
--   billing_stripe_customers.setup_mail_sent_at        last time the mail went out
--   billing_stripe_customers.setup_mail_error          why the last request sent nothing
--
-- The mail carries no amounts and no message contents — only the organization's
-- name, what is missing (billing details / payment method) and the link.
--
-- Additive only: three nullable columns, no policy changes (the table stays
-- service-role only, 0041). The running code selects its columns by name and
-- does not see them; the new code also runs without them (no mail is sent).

alter table public.billing_stripe_customers
  add column setup_mail_requested_at timestamptz,
  add column setup_mail_sent_at timestamptz,
  add column setup_mail_error text check (char_length(setup_mail_error) <= 200);
