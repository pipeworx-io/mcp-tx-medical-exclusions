# @pipeworx/tx-medical-exclusions

Texas HHSC Office of Inspector General (OIG) Medicaid Provider Exclusions
Database screening — check a provider by name, NPI or license number against
the ~13,400-row list of providers ever excluded from Texas's Medicaid
program, the state-level counterpart to the federal HHS OIG LEIE (`leie`
pack) and the sibling of `ny-omig-exclusions` (New York) and
`ca-medical-exclusions` (California).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1784+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `tx_medical_check_exclusion(name?, npi?, license?, limit?)` — screens a
  provider against the HHSC OIG Exclusions Database. An NPI or license match
  is an **identification** (both are exact, provider-specific identifiers); a
  name match — even an exact one — is a **candidate lead only**, since the
  list carries no date of birth and most individual rows have no company
  name to disambiguate same-named providers. Every match carries HHSC OIG's
  own free-text reason and a `currently_excluded` flag derived from whether
  the provider has since been reinstated.
- `tx_medical_exclusion_coverage()` — total exclusions ever recorded, how
  many are currently excluded vs. reinstated, how many carry an NPI or
  license number, occupation diversity, and the oldest/newest exclusion
  date.

## Auth

Keyless.

## Data sources

- <https://oig.hhsc.state.tx.us/oigportal2/exclusions/ctl/dow/mid/384> — the
  HHSC OIG "Download Exclusions File" page. The downloadable file itself
  (CompanyName, LastName, FirstName, MidInitial, Occupation, LicenseNumber,
  NPI, StartDate, AddDate, ReinstatedDate, EligibleToReapplyDate, Waiver,
  WebComments) is fetched via an ASP.NET VIEWSTATE postback from this same
  URL — see "Why a VIEWSTATE postback" below.
- <https://oig.hhsc.state.tx.us/oigportal2/Exclusions> — the online "List of
  Excluded Individuals/Entities Search" (currently-excluded only; this pack's
  data_as_of/source_url always points at the download file, not this page).

### Why no open-data-portal mirror — checked, not assumed

California's S&I list has a stable CKAN `resource_id` mirror on the CHHS Open
Data Portal. Texas does **not** have an equivalent for this dataset: a
Socrata catalog search of data.texas.gov
(`api.us.socrata.com/api/catalog/v1?domains=data.texas.gov`) for "OIG
exclusion", "HHSC exclusion", "excluded provider", "inspector general" and
"Medicaid exclusion" (2026-10-08) returned zero matching datasets. The HHSC
OIG portal is the only source.

### Why a VIEWSTATE postback, not a direct URL

The visible "Download TEXT version of the Exclusions Database File" link on
the HHSC OIG page is `javascript:__doPostBack(...)`, not a plain `href` — a
classic ASP.NET WebForms (DotNetNuke) postback, the same shape as
`reference_aspnet_postback_downloads.md` / the `louisiana-code` precedent (a
VIEWSTATE form is not a wall). `scripts/bake-index.mjs` replays the flow: GET
the page, extract `__VIEWSTATE`/`__VIEWSTATEGENERATOR`/`__EVENTVALIDATION`
from the hidden inputs plus the session cookies, then POST those fields back
with `__EVENTTARGET` set to the download `LinkButton`'s control ID. The
response is the file itself (`Content-Disposition:
attachment;filename=TexasExclusionsData_<today>.txt`) — the filename embeds
the request date, confirming HHSC generates this export live from its
database on every request, which is why this pack uses the capture timestamp
itself as `data_as_of` rather than scraping a separate "last updated" banner
(the page's own `literaldatelastupd` placeholder span is empty on a fresh GET).

### Why this is baked, not a live proxy

Per root CLAUDE.md's standing rule for a table this size, the full list
(13,443 rows at capture time, ~4.6MB as generated TypeScript) is baked by
`scripts/bake-index.mjs` into `src/tx-oig-index-data.ts`, registered in
`workers/gateway/src/pack-baked-indexes.json`, uploaded to KV at deploy, and
injected into every call as `args._bakedIndex` — never a static module-scope
import (fleet #2754: six packs doing that put ~48MB of retained heap into
every gateway isolate and cost about one call in four as a Cloudflare 1102).
A missing or malformed injection throws loudly rather than answering
"not found" — see `src/index.test.ts`.

Re-run `node mcps/tx-medical-exclusions/scripts/bake-index.mjs` periodically
and recommit; `data_as_of` on every response says how stale the baked copy
is.

### What this data includes — a real per-record reason field, verified live

The task that filed `ca-medical-exclusions` (#2805) assumed DHCS publishes a
per-record reason field that turned out not to exist. Checked this dataset
directly against all 13,443 live rows rather than taking HHSC's column list
on faith: `WebComments` **does** carry real per-record reason text — e.g.
"Federal mandated exclusion" (2,105 rows), "License or Certification
revoked, suspended or otherwise terminated" (1,243), "Conviction relating to
Healthcare Fraud" (334). It is **free text from decades of case entry, not a
controlled vocabulary** — 1,847 distinct values over 13,443 rows, including
inconsistent casing and near-duplicate phrasings ("Board action" / "Board
Action" / "board action" all appear separately). Every response carries this
field as `reason`, with `reason_field_caveat` stating plainly that it is free
text, not a normalized statute/reason code.

### Ever-excluded vs. currently-excluded

HHSC OIG's own page says its **online search** returns only providers
**currently** excluded, while this **download file** holds everyone **ever**
excluded, including providers later reinstated — verified directly against
the data: 1,462 of 13,443 rows (2026-10-08 capture) carry a non-blank
`ReinstatedDate`. This pack keeps every row and derives `currently_excluded`
from whether `reinstated_date` is blank, labelled explicitly as **derived**
(HHSC does not publish that boolean itself) via `ever_vs_current_caveat` on
every response.

### Matching

An `npi` query matches only exact 10-digit numeric NPI values (3 of the 600
NPI values in the source data are not well-formed 10-digit strings and are
surfaced as-is but never matched on). A `license` query matches the
`LicenseNumber` field, digits-only, leading zeros stripped — the same
comparison `ny-omig-exclusions` and `ca-medical-exclusions` use. Name
queries match against the provider's assembled individual name
(last/first/middle initial) or company name, case/punctuation-insensitive.

### Reachability

Verified live 2026-10-08 from both a laptop curl and a throwaway
`wrangler dev --remote` Worker on the prod account replaying the exact
GET-then-POST VIEWSTATE handshake: identical `200` / 1,837,673-byte file
attachment from the Cloudflare edge. Like `ny-omig-exclusions` and
`ca-medical-exclusions`, this host needs no Supabase egress relay.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "tx-medical-exclusions": {
      "url": "https://gateway.pipeworx.io/tx-medical-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/tx-medical-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1784+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/tx_medical_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"name":"Gordzelik"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/tx_medical_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "tx-medical-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-tx-medical-exclusions"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-tx-medical-exclusions
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Tx Medical Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
