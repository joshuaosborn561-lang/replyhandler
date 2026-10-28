/**
 * Decision-maker check for reply cards: is the PERSON replying someone the
 * client actually sells to? Target personas come from the client's stored
 * ICP (clients.icp_profile.titles, incl. Fireflies-built ICPs). Deterministic,
 * no model call. Unknown title → "unknown", never a guess.
 */

const TITLE_KEYS = ['title', 'job_title', 'jobTitle', 'jobtitle', 'position', 'job_position',
  'designation', 'role', 'headline', 'occupation'];

const SALES_ROLE = /\b(sales|account executive|account exec|account manager|business development|bdr|sdr|ae|inside sales|sales rep(resentative)?|sales associate|sales consultant|sales engineer|territory manager|outside sales|business developer)\b/i;
const JUNIOR = /\b(intern|assistant|coordinator|specialist|associate|representative|rep|analyst|clerk|receptionist|admin(istrative)?|technician|agent|trainee|student)\b/i;
const OWNER_EXEC = /\b(owner|co-?owner|founder|co-?founder|ceo|chief|president|principal|partner|managing director|general manager|gm|proprietor|c[eoft]o)\b/i;
const SENIOR = /\b(vp|vice president|head|director|svp|evp)\b/i;
const STOP = new Set(['of', 'and', 'the', 'a', 'an', 'for', 'at', 'in', 'to', '&', 'or', 'senior', 'sr', 'jr', 'level', 'leader', 'leaders', 'leadership', 'decision', 'makers', 'maker', 'manager', 'managers', 'director', 'directors', 'head', 'heads', 'vp', 'vice', 'president', 'c', 'suite']);

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** First non-empty title-like field across lead sources (lead fields, custom fields, enrichment). */
function extractLeadTitle(...sources) {
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const pools = [src, src.custom_fields, src.customFields, src.lead, src.person, src.profile];
    for (const pool of pools) {
      if (!pool || typeof pool !== 'object') continue;
      for (const k of TITLE_KEYS) {
        const v = pool[k];
        if (typeof v === 'string' && clean(v) && clean(v).length <= 120) return clean(v);
      }
    }
  }
  return null;
}

/** "Name - Title - Company | LinkedIn" → "Title". */
function titleFromLinkedinHeadline(raw) {
  const parts = String(raw || '').replace(/\s*\|\s*LinkedIn.*$/i, '').split(/\s[-–]\s/).map(clean).filter(Boolean);
  if (parts.length < 2) return null;
  const t = parts[1];
  if (!t || /linkedin/i.test(t) || t.length > 100) return null;
  return t;
}

/** Target buyer titles for a client from its stored ICP profile. */
function targetPersonas(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const titles = Array.isArray(p.titles) ? p.titles : (typeof p.titles === 'string' ? p.titles.split(/[;,]/) : []);
  return titles.map(clean).filter(Boolean).slice(0, 40);
}

function tokens(s) {
  return clean(s).toLowerCase().replace(/[^a-z0-9& ]+/g, ' ').split(' ').filter((t) => t && !STOP.has(t));
}

function titleMatchesPersona(title, persona) {
  const t = clean(title).toLowerCase();
  const p = clean(persona).toLowerCase();
  if (!t || !p) return false;
  if (t.includes(p) || p.includes(t)) return true;
  const pt = tokens(p);
  const tt = new Set(tokens(t));
  // Owner/exec personas match any owner/exec title.
  if (OWNER_EXEC.test(p) && OWNER_EXEC.test(t)) return true;
  if (!pt.length) return false;
  const hit = pt.filter((x) => tt.has(x)).length;
  if (!hit) return false;
  return !JUNIOR.test(t) || SENIOR.test(t) || /manager/.test(t);
}

/**
 * @returns {{status:'yes'|'no'|'unknown', title:string|null, reason:string}}
 */
function judgeDecisionMaker(title, personas = []) {
  const t = clean(title);
  const targets = (personas || []).map(clean).filter(Boolean);
  if (!t) return { status: 'unknown', title: null, reason: 'title unknown' };
  const matched = targets.find((p) => titleMatchesPersona(t, p));
  const targetsSales = targets.some((p) => SALES_ROLE.test(p));
  if (SALES_ROLE.test(t) && !OWNER_EXEC.test(t) && !(targetsSales && matched)) {
    return { status: 'no', title: t, reason: 'sales role' };
  }
  if (matched) return { status: 'yes', title: t, reason: `matches ICP buyer (${matched})` };
  if (OWNER_EXEC.test(t)) return { status: 'yes', title: t, reason: 'owner/executive' };
  if (JUNIOR.test(t) && !SENIOR.test(t)) return { status: 'no', title: t, reason: 'not a buying role' };
  if (!targets.length) {
    return SENIOR.test(t)
      ? { status: 'yes', title: t, reason: 'senior leader' }
      : { status: 'unknown', title: t, reason: 'no ICP buyer titles to compare' };
  }
  return { status: 'no', title: t, reason: 'not an ICP buyer title' };
}

/** Card line, e.g. "Decision maker: No, sales role (Account Executive)". */
function decisionMakerText(dm) {
  if (!dm || !dm.status) return null;
  if (dm.status === 'unknown') {
    return dm.title ? `Decision maker: unknown, ${dm.reason} (${dm.title})` : 'Decision maker: unknown (title not found)';
  }
  const word = dm.status === 'yes' ? 'Yes' : 'No';
  return `Decision maker: ${word}, ${dm.reason} (${dm.title})`;
}

async function loadClientPersonas(db, clientId) {
  if (!db || !clientId) return [];
  try {
    const { rows } = await db.query('SELECT name, icp_profile FROM clients WHERE id = $1', [clientId]);
    // Code-owned buyer titles (e.g. SalesGlider's own ICP) beat stored ones.
    const { DEFAULT_CLIENT_PERSONAS, CLIENT_TAG_ALIASES } = require('./reply-icp-variants');
    const { clientTagFor } = require('./prospect-enrich');
    const slug = rows[0]?.name ? clientTagFor(rows[0].name) : '';
    const fixed = DEFAULT_CLIENT_PERSONAS[CLIENT_TAG_ALIASES[slug] || slug];
    if (fixed) return [...fixed];
    return targetPersonas(rows[0]?.icp_profile);
  } catch (err) {
    if (!/icp_profile/.test(err.message || '')) console.warn('[DecisionMaker] personas read skipped', { err: err.message });
    return [];
  }
}

/** Store on the reply's icp_verdict so refreshes / follow-up cards keep it. */
async function persistDecisionMaker(db, replyId, dm) {
  if (!db || !replyId || !dm) return;
  try {
    await db.query(
      `UPDATE pending_replies
          SET icp_verdict = COALESCE(icp_verdict, '{}'::jsonb) || jsonb_build_object('decision_maker', $1::jsonb),
              updated_at = now()
        WHERE id = $2`,
      [JSON.stringify(dm), replyId]
    );
  } catch (err) {
    if (!/icp_verdict/.test(err.message || '')) console.warn('[DecisionMaker] persist skipped', { err: err.message });
  }
}

module.exports = {
  extractLeadTitle,
  titleFromLinkedinHeadline,
  targetPersonas,
  titleMatchesPersona,
  judgeDecisionMaker,
  decisionMakerText,
  loadClientPersonas,
  persistDecisionMaker,
};
