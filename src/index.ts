interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Texas HHSC Office of Inspector General (OIG) Medicaid Provider Exclusions
 * Database screening — fleet #2809, the third state exclusion pack after
 * mcps/ny-omig-exclusions (#2788) and mcps/ca-medical-exclusions (#2805).
 *
 * Beside the federal HHS OIG LEIE (mcps/leie) and the SAM federal
 * exclusions list, Texas runs its own Medicaid exclusion list through the
 * Health and Human Services Commission (HHSC) Office of Inspector General:
 * providers barred from billing or participating in Texas Medicaid for
 * license revocation/suspension, federal mandated exclusion, conviction
 * (including healthcare fraud), board action, and similar grounds. This is
 * that list, for Texas only — one pack per jurisdiction (root CLAUDE.md
 * rule 5); Florida (AHCA) is filed as the next state on this task's close.
 *
 * SOURCE AND SHAPE. No open-data-portal mirror exists for this dataset —
 * checked, not assumed: the Socrata catalog at data.texas.gov
 * (api.us.socrata.com/api/catalog/v1?domains=data.texas.gov) returns zero
 * datasets for "OIG exclusion", "HHSC exclusion", "excluded provider",
 * "inspector general" or "Medicaid exclusion" (2026-10-08) — unlike
 * California's S&I list, which has a stable CKAN resource_id mirror on the
 * CHHS Open Data Portal. The HHSC OIG portal is the only source. Its
 * "Download Exclusions File" page is an ASP.NET WebForms (DotNetNuke) page
 * where the visible download link is a VIEWSTATE postback, not a direct
 * URL (same shape as reference_aspnet_postback_downloads.md / the
 * louisiana-code precedent — a VIEWSTATE form is not a wall). Verified live
 * 2026-10-08 from both a laptop curl and a throwaway `wrangler dev --remote`
 * Worker on the prod account replaying the same GET-then-POST handshake:
 * identical 200 / 1,837,673-byte attachment from the Cloudflare edge — so,
 * like ny-omig-exclusions and ca-medical-exclusions, this host needs no
 * Supabase egress relay.
 *
 * Root CLAUDE.md's standing rule 3 still applies regardless of
 * reachability: a baked table this size (13,443 rows, ~4.1MB as generated
 * TS) never sits in gateway module scope. It is baked by
 * mcps/tx-medical-exclusions/scripts/bake-index.mjs into
 * src/tx-oig-index-data.ts, registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy
 * (scripts/sync-gateway-static-json.mjs), and injected here as
 * `args._bakedIndex` — same pattern as the two precedent packs (fleet
 * #2754: six packs' worth of static imports put ~48MB of retained heap
 * into every isolate and cost about one gateway call in four as a
 * Cloudflare 1102).
 *
 * This is an official Texas State public enforcement record that HHSC OIG
 * publishes specifically so providers, payers and the public can screen
 * against it — baking a copy needs no reuse grant, same footing as the
 * federal LEIE and the two precedent state packs (not the "personal data"
 * carve-out, which covers bulk-redistributing private details, not an
 * official sanctions list a regulator publishes for exactly this purpose).
 *
 * WebComments IS A REAL PER-RECORD REASON FIELD, VERIFIED LIVE — the task
 * that filed #2805 (California) assumed a per-record reason field that
 * turned out not to exist; checked this one directly against all 13,443
 * live rows rather than taking HHSC's column list on faith, and it DOES
 * exist here: e.g. "Federal mandated exclusion" (2,105 rows), "License or
 * Certification revoked, suspended or otherwise terminated" (1,243),
 * "Conviction relating to Healthcare Fraud" (334). It is FREE TEXT from
 * decades of case entry, not a controlled vocabulary (1,847 distinct
 * values over 13,443 rows, with inconsistent casing/near-duplicates like
 * "Board action" / "Board Action" / "board action"), so every response
 * says this plainly (REASON_FIELD_CAVEAT) rather than presenting it as a
 * normalized statute/reason code.
 *
 * THIS IS THE "EVER EXCLUDED" FILE, NOT "CURRENTLY EXCLUDED ONLY" — HHSC's
 * own page says the online search returns only providers currently
 * excluded, while this downloadable file holds everyone ever excluded,
 * some since reinstated. 1,462 of 13,443 rows carry a ReinstatedDate.
 * `currently_excluded` is DERIVED here (HHSC publishes no such boolean
 * itself) from whether reinstated_date is blank, and labelled as derived
 * on every match so a caller sees both the full history and today's status.
 *
 * MATCHING MODEL, same shape as the two precedent packs: an NPI match
 * (exact 10-digit) or a license-number match identifies a specific
 * provider. A name match — even an exact one — is a CANDIDATE, never an
 * identification: this list has no date of birth, CompanyName is blank
 * for the vast majority of (individual) rows, and common surnames repeat
 * across 13,443 rows spanning 1959-2026.
 *
 * Keyless.
 */
import type { TxOigRow } from './tx-oig-index-data.js';

// fleet #2754 / root CLAUDE.md rule 3 — the baked table (13,443 rows,
// ~4.1MB) is injected by the gateway as `args._bakedIndex`, loaded from KV
// once per isolate. NEVER value-import ./tx-oig-index-data.js here — only
// the type-only import above, which is erased at compile time. A value
// import puts the whole table back in the bundle and into every isolate's
// heap; scripts/check-gateway-bundle-size.mjs fails the deploy if that
// happens.
let ROWS: TxOigRow[] = [];
let DATA_AS_OF = '';
let SOURCE_URL = '';
let SEARCH_URL = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.TX_OIG_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (root CLAUDE.md rule 2): answering "no exclusion
    // found" from an empty table would be a silent wrong answer,
    // indistinguishable from a real clean screening result.
    throw new Error(
      `tx-medical-exclusions: the baked HHSC OIG exclusions index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as TxOigRow[];
  DATA_AS_OF = String(idx?.TX_OIG_DATA_AS_OF ?? '');
  SOURCE_URL = String(idx?.TX_OIG_SOURCE_URL ?? 'https://oig.hhsc.state.tx.us/oigportal2/exclusions/ctl/dow/mid/384');
  SEARCH_URL = String(idx?.TX_OIG_SEARCH_URL ?? 'https://oig.hhsc.state.tx.us/oigportal2/Exclusions');
  CAPTURED_AT = String(idx?.TX_OIG_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.TX_OIG_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'Texas Health and Human Services Commission (HHSC) Office of Inspector General (OIG) — Medicaid Provider Exclusions Database File';

const REASON_FIELD_CAVEAT =
  'HHSC OIG\'s WebComments field is genuine free text entered case-by-case over decades, not a controlled vocabulary — the same underlying reason can appear under several different phrasings/casings (e.g. "Board action" vs "Board Action"). Treat it as the agency\'s own description of the exclusion, not a normalized statute or reason code.';

const EVER_VS_CURRENT_CAVEAT =
  'This dataset is HHSC OIG\'s "ever excluded" Exclusions Database File, not a currently-excluded-only list — it includes providers later reinstated. currently_excluded is DERIVED by this pack from whether reinstated_date is blank; HHSC does not publish that boolean itself.';

const NOT_AN_ANSWER =
  'Name matches are CANDIDATES, not identifications — this list has no date of birth to tell same-named providers apart, and most individual rows carry no business/company name. Only an NPI or license-number match identifies a specific provider. Confirm a name match against the provider\'s NPI or license before acting on it.';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function fullName(r: TxOigRow): string {
  const parts = [r.last_name, r.first_name, r.mid_initial].filter((p): p is string => Boolean(p));
  return parts.join(' ');
}

function displayName(r: TxOigRow): string {
  return fullName(r) || r.company_name || r.last_name || 'Unknown';
}

function isTenDigitNpi(s: string): boolean {
  return /^\d{10}$/.test(s);
}

type MatchType = 'npi_match' | 'license_match' | 'name_candidate_exact' | 'name_candidate_partial';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: 'The NPI matched exactly against this provider\'s listed NPI. An NPI identifies one provider, so this is an identification.',
  license_match: 'The license number matched exactly. A license number identifies one provider, so this is an identification.',
  name_candidate_exact: 'The name matched exactly (last name, full name, or company name), but this list has no date of birth to confirm it is the same person — several excluded providers can share a name. Confirm with NPI or license number before acting.',
  name_candidate_partial: 'The name is a partial/substring match, not exact, checked against the provider\'s individual name and company name. Treat as a lead to check, not a finding. Confirm with NPI or license number.',
};

function shape(r: TxOigRow, matchType: MatchType) {
  return {
    provider_name: fullName(r) || null,
    company_name: r.company_name,
    occupation: r.occupation,
    license_number: r.license_number,
    npi: r.npi,
    excluded_since: r.excluded_since,
    added_date: r.added_date,
    reinstated_date: r.reinstated_date,
    eligible_to_reapply_date: r.eligible_to_reapply_date,
    currently_excluded: !r.reinstated_date,
    reason: r.web_comments,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : '';
  const licenseRaw = typeof args.license === 'string' ? args.license.trim() : '';
  const licenseDigits = licenseRaw ? digitsOnly(licenseRaw) : '';

  if (!nameRaw && !npiRaw && !licenseRaw) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen), and/or npi, and/or license. An NPI or license match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));

  // Identity-grade matches first: NPI (exact 10-digit), then license number
  // (exact, leading-zero-tolerant) — both exact.
  const npiMatches = npiRaw && isTenDigitNpi(npiRaw) ? ROWS.filter((r) => r.npi && digitsOnly(r.npi) === npiRaw) : [];
  const licenseMatches = licenseDigits
    ? ROWS.filter((r) => r.license_number && digitsOnly(r.license_number).replace(/^0+/, '') === licenseDigits.replace(/^0+/, '') && digitsOnly(r.license_number).length > 0)
    : [];

  const identitySeen = new Set<TxOigRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  for (const r of npiMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'npi_match'));
  }
  for (const r of licenseMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'license_match'));
  }

  // Name-candidate matches: exact normalized name (last name, full name, or
  // company name), then token-substring over name + company.
  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue; // already reported as an identity match
      const lastNorm = r.last_name ? normalize(r.last_name) : '';
      const fullNorm = normalize(fullName(r));
      const companyNorm = r.company_name ? normalize(r.company_name) : '';
      if ((lastNorm && qNorm === lastNorm) || (fullNorm && qNorm === fullNorm) || (companyNorm && qNorm === companyNorm)) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (
        qTokens.length > 0 &&
        qTokens.every((t) => fullNorm.includes(t) || companyNorm.includes(t))
      ) {
        partial.push(shape(r, 'name_candidate_partial'));
      }
    }
    nameResults = [...exact, ...partial];
  }

  const combined = [...identityResults, ...nameResults];
  const truncated = combined.length > limit;
  const matches = combined.slice(0, limit);

  if (matches.length === 0) {
    return {
      found: false,
      result: 'No match found in the Texas HHSC OIG Medicaid Provider Exclusions Database for that provider.',
      screened: { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null },
      caveat: `This checks the Texas HHSC OIG exclusions database only. It does not cover the federal HHS OIG LEIE, the federal SAM exclusions list, New York's OMIG list (see ny-omig-exclusions), California's DHCS S&I list (see ca-medical-exclusions), or any other state's Medicaid exclusion list. ${EVER_VS_CURRENT_CAVEAT}`,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  return {
    found: true,
    screened: { name: nameRaw || null, npi: npiRaw || null, license: licenseRaw || null },
    count: matches.length,
    truncated,
    matches,
    not_an_identification: NOT_AN_ANSWER,
    reason_field_caveat: REASON_FIELD_CAVEAT,
    ever_vs_current_caveat: EVER_VS_CURRENT_CAVEAT,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage() {
  const withNpi = ROWS.filter((r) => r.npi).length;
  const withLicense = ROWS.filter((r) => r.license_number).length;
  const currentlyExcluded = ROWS.filter((r) => !r.reinstated_date).length;
  const reinstated = ROWS.length - currentlyExcluded;
  const dates = ROWS.map((r) => r.excluded_since).filter((d): d is string => Boolean(d)).sort();
  const occupations = new Set(ROWS.map((r) => r.occupation).filter(Boolean));

  return {
    found: true,
    total_exclusions: TOTAL_ROWS,
    currently_excluded: currentlyExcluded,
    reinstated,
    with_npi: withNpi,
    with_license_number: withLicense,
    distinct_occupations: occupations.size,
    oldest_exclusion_date: dates[0] ?? null,
    newest_exclusion_date: dates[dates.length - 1] ?? null,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    reason_field_caveat: REASON_FIELD_CAVEAT,
    ever_vs_current_caveat: EVER_VS_CURRENT_CAVEAT,
    search_url: SEARCH_URL,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'tx_medical_check_exclusion',
    description:
      'Is this healthcare provider excluded from the Texas Medicaid program? Screens a person or business name, an NPI, and/or a license number against the Texas HHSC Office of Inspector General (OIG) Medicaid Provider Exclusions Database — the state-level counterpart to the federal HHS OIG LEIE (see the leie pack) for Texas specifically, and the sibling of ny_omig_check_exclusion (New York) and ca_medical_check_exclusion (California). Answers "is this provider excluded from Texas Medicaid", "check this NPI against the Texas exclusions list", or pre-payment/credentialing screening for a Texas Medicaid provider. '
      + 'An NPI or license-number match is an IDENTIFICATION (both are exact, provider-specific identifiers); a name match — even an exact one — is a CANDIDATE lead only, since this list carries no date of birth to tell same-named providers apart. Every match carries HHSC OIG\'s own free-text reason (e.g. "Federal mandated exclusion", "Conviction relating to Healthcare Fraud") and a currently_excluded flag DERIVED from whether the provider has since been reinstated — this dataset covers everyone EVER excluded, not only those currently excluded. Pass npi or license to turn a name lead into an identification. Sourced from the Texas HHSC OIG Exclusions Database File, keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or business name to screen, e.g. "John Smith" or "Acme Pharmacy Corp". Matched against the provider\'s individual name and company name, any word order.' },
        npi: { type: 'string', description: 'The provider\'s 10-digit NPI, if known. An NPI match is an identification rather than a name lead — always pass it when known.' },
        license: { type: 'string', description: 'Texas professional license number, if known. A license match is an identification.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'tx_medical_exclusion_coverage',
    description:
      'What the Texas HHSC OIG Medicaid Provider Exclusions data covers and how current it is: total exclusions ever recorded, how many are currently excluded vs. reinstated, how many carry an NPI or license number, how many distinct occupations appear, the oldest and newest exclusion dates, and when this pack\'s copy was captured. Use to check the screening data is fresh enough to rely on before a compliance decision, and to see the one-line notes on the free-text reason field and the ever-vs-currently-excluded distinction. Sourced from the Texas HHSC OIG Exclusions Database File, keyless.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'tx_medical_check_exclusion':
      return checkExclusion(args);
    case 'tx_medical_exclusion_coverage':
      return coverage();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
