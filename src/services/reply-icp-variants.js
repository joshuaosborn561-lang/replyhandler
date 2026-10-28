/**
 * Per-client ICP source of record — ported from topup's icp-llm edge
 * function (joshuaosborn561-lang/topup, supabase/functions icp-llm) and
 * `topup.icp_variants`.
 *
 * Topup's site_check / icp verbs grade by Jev category pick: fit=yes only
 * when `answers.category.choice === PASS[variant]`. Do not invent labels.
 *
 * Source: https://github.com/joshuaosborn561-lang/topup
 *   - src/stages/icp/index.ts (variant from topup.icp_variants)
 *   - src/canon/siteCheck.ts (same verdict table)
 *   - client_salesglider.icp_llm_results (fit, prob, reason, answers)
 */

/** Pass token per jev_variant — from icp-llm `PASS`. */
const PASS = Object.freeze({
  choice: 'commercial_trade_contractor',
  emcor: 'commercial_facility_operator',
  emcor2: 'buyer_with_own_facility',
  deeproots: 'independent_manufacturer',
  bcp: 'private_equity_firm',
  b2b_service: 'b2b_service_business',
});

/**
 * Category questions from icp-llm `JEV_Q`. Only the `choice`-style
 * variants used in production (topup.icp_variants as of 2026-10-11).
 */
const VARIANTS = Object.freeze({
  choice: {
    pass: PASS.choice,
    instructions:
      'Which best describes this company, based on its website?',
    criteria: {
      commercial_trade_contractor:
        'Independent US contractor whose own crews perform a building trade (roofing, HVAC, mechanical, plumbing, electrical, fire protection, concrete, paving, glazing, painting, flooring, drywall, framing, insulation, masonry, steel erection, excavation, site work, low voltage, security systems, signage, commercial doors, solar) and that clearly does commercial, industrial, institutional or multifamily work.',
      residential_trade_contractor:
        'Trade contractor focused on homeowners, with commercial work absent or only mentioned in passing.',
      general_contractor:
        'General contractor, construction manager, design build firm, developer or builder that coordinates subcontractors.',
      supplier_manufacturer_rental:
        'Sells, supplies, distributes, manufactures, fabricates for others, or rents equipment; or a manufacturers rep.',
      consultant_engineer:
        'Consulting, engineering, architecture, inspection, testing, commissioning, energy audits or facility management.',
      franchise_or_chain:
        'Franchise brand, franchise location or national chain.',
      other_not_contractor:
        'Anything else: cleaning, landscaping, pools, software, staffing, non US, or not a contractor.',
    },
  },
  emcor2: {
    pass: PASS.emcor2,
    instructions:
      'We sell commercial HVAC service and maintenance. Which best describes this organization, based on its website?',
    criteria: {
      buyer_with_own_facility:
        'Any business or organization that runs its own physical building, plant, shop, office, clinic, school, warehouse, storage facility, hotel, church or rental property, so it pays for heating and cooling. Includes manufacturers, processors, labs, medical, dental and veterinary practices, nonprofits, property managers and building owners. Industry and size do not matter.',
      hvac_or_building_services_contractor:
        'HVAC, mechanical, refrigeration, plumbing, electrical or building services contractor: a competitor, not a buyer.',
      other_construction_contractor:
        'Construction contractor, builder or developer.',
      national_chain_or_public_corporation:
        'Location of a national chain, franchise, or large public corporation whose buildings are handled by a corporate facilities team.',
      homeowner_or_home_based:
        'Serves homeowners or is run from a home, including residential real estate agents.',
      no_physical_facility:
        'Online only, software, staffing, or a remote service or consultant with no building of its own.',
    },
  },
  deeproots: {
    pass: PASS.deeproots,
    instructions:
      'Which best describes this company, based on its website? We are looking for independent, owner run manufacturers.',
    criteria: {
      independent_manufacturer:
        'Independent, privately owned company that makes physical products in its own plant or shop: fabrication, machining, metal or plastic products, food or beverage processing, equipment, trailers, wood products, printing, chemicals and similar.',
      dealer_distributor_wholesaler:
        'Sells, distributes, wholesales or deals products made by others, including equipment and auto dealers.',
      contractor_or_trade:
        'Construction contractor or trade service company.',
      trucking_logistics:
        'Trucking, freight, logistics, warehousing or transportation company.',
      subsidiary_chain_or_franchise:
        'Part of a large or public corporation, a chain with many locations, or a franchise.',
      farm_or_consumer_service:
        'Farm or ranch, retail store, restaurant, or consumer service business.',
      other: 'Anything else, or the website is too thin to tell.',
    },
  },
  bcp: {
    pass: PASS.bcp,
    instructions:
      'We sell vCISO and cybersecurity leadership to investors who own and operate companies. Which best describes this firm, based on its website? Judge by the money it actually deploys, not by a phrase in a boilerplate line. A firm that says "private equity and venture capital" but whose portfolio is seed and Series A startups is venture capital. A firm that takes control or majority positions in established, revenue generating companies is private equity even if it also runs a small venture sleeve.',
    criteria: {
      private_equity_firm:
        'Buyout or control investor in established operating companies: private equity, lower middle market or middle market buyouts, platform and add on acquisitions, majority or control stakes, growth equity in profitable companies, independent sponsors, search funds, family offices doing control deals, and the operating partner or portfolio operations teams inside them. Mentions EBITDA, value creation, portfolio operations, recapitalization, management buyouts, or holding periods.',
      venture_capital_firm:
        'Venture investor in startups: pre seed, seed, Series A or B, early stage, venture capital, micro VC, angel fund or syndicate, accelerator or incubator, studio, or a corporate venture arm. Minority stakes in young, pre profit technology or life science companies.',
      investment_bank_or_advisor:
        'Investment bank, M&A advisory, business brokerage, placement agent, valuation or transaction advisory firm that advises on deals rather than owning companies.',
      other_investor_or_asset_manager:
        'Hedge fund, credit or private debt fund, real estate investor or REIT, fund of funds, wealth or asset management, RIA, insurance or retail financial services.',
      operating_company_not_investor:
        'An operating business, including a portfolio company, that sells its own products or services rather than investing in companies.',
      other_or_too_thin:
        'Anything else, or the website is too thin to tell what the firm invests in.',
    },
  },
  // SalesGlider's own ICP (Josh, 2026-10-28): any B2B service business with
  // roughly $36K+ customer lifetime value. No longer limited to trade
  // contractors. `strictCache` = only accept a cached Jev result graded for
  // THIS variant (the generic "any jev:* row" fallback would reuse another
  // client's or the old trade-contractor verdict).
  b2b_service: {
    pass: PASS.b2b_service,
    strictCache: true,
    instructions:
      'We sell outbound lead generation and appointment setting to B2B service businesses whose customers are worth roughly $36,000 or more in lifetime value. Which best describes this company, based on its website? Any B2B service business qualifies; it does not have to be a trade contractor.',
    criteria: {
      b2b_service_business:
        'Independent business that sells services to other businesses, where a typical customer is worth about $36,000 or more over its lifetime (retainers, recurring contracts, or large projects). Includes staffing and recruiting, marketing and advertising agencies, consulting, IT services and managed service providers, accounting and bookkeeping, legal, engineering, logistics and freight, commercial insurance and financial advisory, commercial trade contractors and facility services (roofing, HVAC, mechanical, plumbing, electrical, cleaning, security), and similar professional or field services.',
      consumer_or_local_retail:
        'Sells mainly to consumers or homeowners: retail, restaurants, salons, fitness, residential contractors, real estate agents, healthcare practices that bill patients.',
      product_or_software_vendor:
        'Sells software, a SaaS product, or physical products: manufacturers, distributors, wholesalers, dealers, equipment rental.',
      low_value_or_solo:
        'Solo freelancer, hobby or side business, or a service where a typical customer is worth far less than $36,000 over its lifetime.',
      enterprise_chain_or_nonprofit:
        'Large public corporation, national chain, franchise location, government body or nonprofit.',
      other_or_too_thin:
        'Anything else, or the website is too thin to tell what the company sells.',
    },
  },
});

/** client_tag → jev_variant from topup.icp_variants (2026-10-11). */
const DEFAULT_CLIENT_VARIANTS = Object.freeze({
  bcp: { jev_variant: 'bcp', disco_icp: 'bcp', note: 'private_equity_firm passes' },
  deep_roots: { jev_variant: 'deeproots', disco_icp: 'deeproots', note: 'independent_manufacturer passes' },
  emcor: { jev_variant: 'emcor2', disco_icp: 'emcor', note: 'buyer_with_own_facility passes' },
  // localOverride: replyhandler grades SalesGlider's own replies with this
  // variant even though topup.icp_variants still says `choice` (trade
  // contractors), which topup's own lead-gen pipeline keeps using.
  salesglider: {
    jev_variant: 'b2b_service',
    disco_icp: 'salesglider',
    note: 'b2b_service_business passes (Josh 2026-10-28: any B2B service business, ~$36K+ LTV)',
    localOverride: true,
  },
});

/**
 * Buyer titles per client when the code, not clients.icp_profile, is the
 * source of record. Wins over stored titles for these clients.
 * SalesGlider: owners, founders, CEOs, presidents, partners, heads of
 * sales/growth at the target B2B service businesses.
 */
const DEFAULT_CLIENT_PERSONAS = Object.freeze({
  salesglider: Object.freeze([
    'Owner', 'Founder', 'CEO', 'President', 'Partner', 'Head of Sales', 'Head of Growth',
  ]),
});

/** ReplyHandler client names → topup.client_map tags. */
const CLIENT_TAG_ALIASES = Object.freeze({
  bcp: 'bcp',
  bolder_cyber_partners: 'bcp',
  bolder_cyber: 'bcp',
  deep_roots: 'deep_roots',
  deep_roots_capital: 'deep_roots',
  deeproots: 'deep_roots',
  emcor: 'emcor',
  mesa: 'emcor',
  mesa_energy: 'emcor',
  salesglider: 'salesglider',
  sales_glider: 'salesglider',
});

function variantSpec(jevVariant) {
  const key = String(jevVariant || '').trim();
  return VARIANTS[key] || null;
}

module.exports = {
  PASS,
  VARIANTS,
  DEFAULT_CLIENT_VARIANTS,
  DEFAULT_CLIENT_PERSONAS,
  CLIENT_TAG_ALIASES,
  variantSpec,
};
