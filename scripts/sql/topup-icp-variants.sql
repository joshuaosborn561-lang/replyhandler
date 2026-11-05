-- Apply on Supabase project azpapwtnrbzywlnxxecz (schema topup).
-- ReplyHandler does not write topup tables. Run this by hand.
--
-- 1. Culture Fits, Vasco, and Nutter: Jev variants from topup.client_icp.
--    Pass labels match src/services/reply-icp-variants.js.
-- 2. SalesGlider: replace the trade-contractor `choice` variant with
--    `b2b_service` (any high-ticket B2B). ReplyHandler already grades
--    with that question. topup icp-llm PASS/JEV_Q does not include
--    b2b_service yet; a lead-gen batch that grades salesglider through
--    icp-llm will not recognize the label until that function is updated.

insert into topup.icp_variants (client_tag, jev_variant, disco_icp, note, updated_at)
values
  ('culture_fits', 'culture_fits', 'culture_fits', 'msp_owner passes', now()),
  ('vasco', 'vasco', 'vasco', 'franchised_auto_dealership passes', now()),
  ('nutter', 'nutter', 'nutter', 'independent_hospital passes', now())
on conflict (client_tag) do update set
  jev_variant = excluded.jev_variant,
  disco_icp = excluded.disco_icp,
  note = excluded.note,
  updated_at = now();

update topup.icp_variants
   set jev_variant = 'b2b_service',
       disco_icp = 'salesglider',
       note = 'b2b_service_business passes (any high-ticket B2B business)',
       updated_at = now()
 where client_tag = 'salesglider'
   and jev_variant is distinct from 'b2b_service';
