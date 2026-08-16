# marktplaats-mcp

A read-only MCP server for [marktplaats.nl](https://www.marktplaats.nl), the Dutch classifieds site.
It lets an agent search listings and read price, specs, condition, delivery method, location and seller.

Built with the `har-to-mcp` skill: the site's own browser traffic was recorded once, then the internal API was called directly.
No browser runs at query time.

## Status

Capture date: **2026-08-16**.
Verified against the live site the same day: 42 client checks and 14 MCP protocol checks, all passing.

Consumer sites change. Re-record when tools start failing. See "Re-recording" below.

## Credentials

**None.** Every tool is a public, logged-out GET request.
There are no environment variables, no tokens, no cookies, and nothing to refresh.

This is the whole reason the server is simple. Read-only public search needs no session.

## Install

Requires Node.js 20 or newer.

```bash
git clone <this-repo-url> marktplaats-mcp
cd marktplaats-mcp
npm install
npm run build
```

Register with Claude Code. Run this from the repo root and it fills in the path for you:

```bash
claude mcp add marktplaats -- node "$PWD/dist/server.js"
```

Or add it to any MCP client config, using an absolute path to your clone:

```json
{
  "mcpServers": {
    "marktplaats": {
      "command": "node",
      "args": ["/absolute/path/to/marktplaats-mcp/dist/server.js"]
    }
  }
}
```

Check it works:

```bash
npm run test:mcp
```

## Tools

### `search_listings`

Search the site. This is the primary tool and it already carries price, specs and delivery, so most questions need only this one call.

| Argument | Type | Notes |
| --- | --- | --- |
| `query` | string, required | Free text, for example `iphone 15` or `racefiets`. |
| `limit` | 1-100 | Default 30. |
| `offset` | integer | For paging. |
| `sortBy` | `relevance` \| `newest` \| `oldest` \| `price_asc` \| `price_desc` | Default `relevance`. |
| `minPriceEur`, `maxPriceEur` | number | Asking price in euros. |
| `condition` | array of `new`, `like_new`, `refurbished`, `used`, `not_working` | Several may be given. |
| `delivery` | `shipping` \| `pickup` | See the delivery note below. |
| `postcode`, `distanceKm` | string, number | Dutch postcode such as `1011AB`. `distanceKm` needs `postcode`. |
| `searchInDescription` | boolean | Default true. |

### `get_listing`

Full detail for one listing, by id (`a1517154667`) or URL.
Adds what search does not carry: shipping carrier and transit days, view count, favourites, listed-since date, seller tenure, category path, bidding and reserved state, CO2 estimate, and the full description.

### `get_seller`

A seller's public profile by numeric seller id.
Useful for telling a private seller from a shop.

## Field notes

**Delivery has three values, not two.**
`shipping` (Verzenden), `pickup` (Ophalen), and `both` (Ophalen of Verzenden).
`both` is the most common value on the site, at roughly 13 of every 30 results.
Filtering by `delivery: "shipping"` also returns `both` listings, which is correct, because those sellers will ship.
Only `shipping` and `pickup` are filterable; the site has no filter for `both`.

**Price can be absent.**
`priceEur` is `null` when the listing takes bids, is free, or names no price.
Read `priceType` and `priceLabel` in that case.

**Sponsored results are included and flagged.**
`isSponsored` is true for any paid placement.
`sponsoredType` tells them apart: `dagtopper` is a boosted private listing (the site shows "Topadvertentie"), `admarkt` is a professional-seller advert.
Filter on `isSponsored` if you want organic results only.

**Dutch values are kept.**
Every translated field has a `Raw` twin: `condition` and `conditionRaw`, `delivery` and `deliveryRaw`.
Use the raw value to check a translation against what the site shows.

**`limit` is enforced by this client, not the site.**
The search API injects sponsored placements on top of the requested limit, so `limit=3` can return 18 rows.
The client slices back to the requested count, keeping the site's own ordering.

## How it works

The site is server-rendered Next.js. It has no public API. Two internal routes carry everything:

| Route | Type | Used for |
| --- | --- | --- |
| `/lrp/api/search` | JSON | Search. Same payload the results page embeds. |
| `/v/api/seller-profile/{id}` | JSON | Seller profiles. |
| `/{itemId}` | HTML | Detail. Redirects to the canonical URL; data is in `window.__CONFIG__` and schema.org JSON-LD. |

Filters map to query parameters like this:

- Price is a range facet: `attributeRanges[]=PriceCents:<from>:<to>`. A plain `PriceCentsFrom` is silently ignored.
- Condition and delivery are attribute ids: `attributesById[]=30` and similar. Confirmed live: Nieuw 30, Zo goed als nieuw 31, Gebruikt 32, Niet werkend 13940, Refurbished 14050, Ophalen 33, Verzenden 34.
- Distance is `postcode=1011AB&distanceMeters=5000`.

## What is fragile

Everything above comes from JSON except two reads on the detail page.
`get_listing` parses the rendered HTML for the spec table (`Attributes-module-item`) and the description (`Description-module-description`).
Those two are the first things to break if the site restyles.

If they break, `get_listing` still returns price, seller, category, shipping, stats and flags, because those come from `window.__CONFIG__`.
`search_listings` does not depend on any DOM parsing at all.

The AWS WAF bot-control SDK is present on the site.
It did not challenge plain HTTP requests during the capture or during verification.
If it starts to, the tools will surface the HTTP status in the error message.

## Testing

```bash
npm test             # both suites
npm run test:client  # 42 checks against the live site
npm run test:mcp     # 14 checks over the real MCP stdio protocol
```

Both are read-only and safe to run. They hit the live site, so they need network access and take about a minute.

CI mirrors that split. Type check and build run on every push and never touch the site.
The live suites run weekly, as an early warning that the site changed.

Call a tool by hand without wiring up a client:

```bash
npm run ask -- search '{"query":"iphone 15 pro","maxPriceEur":500}'
npm run ask -- listing a1517154667
npm run ask -- seller 57429132
```

## Re-recording

If the site changes, re-run the capture and re-check the parsing.

Capture drives a real browser, so it needs Playwright. The MCP server does not, which is why
Playwright is not a dependency of this package and a normal install stays small. Install it
only when you need to re-record:

```bash
npm install -D playwright
npx playwright install chromium
npm run capture     # drives a headless Chromium over the public search flow
```

Already have Playwright elsewhere? Point at it instead of installing a second copy:

```bash
MARKTPLAATS_PLAYWRIGHT=/path/to/node_modules/playwright npm run capture
```

The HAR lands in `captures/` and screenshots in `shots/`. **Both are gitignored, and must stay
that way.** A HAR records real request headers, so yours will contain your own consent, WAF and
analytics cookies. The capture never logs in, so these are anonymous identifiers rather than
account credentials, but they still identify your browser session. Never commit a HAR, and never
`git add -f` those directories.

Then follow the `har-to-mcp` skill from Phase 1.

## Project layout

```
src/client.ts     typed HTTP client for marktplaats.nl, knows nothing about MCP
src/server.ts     the MCP surface, contains no parsing
scripts/verify.mjs      client checks against the live site
scripts/smoke-mcp.mjs   checks over the real MCP stdio protocol
scripts/capture.mjs     re-records the HAR, needs Playwright
scripts/ask.mjs         call a tool from the shell
```

Keeping the two `src` files apart is deliberate. Parsing changes stay in `client.ts`, and the
tool surface in `server.ts` stays stable.

`captures/`, `shots/` and `work/` are gitignored build-time artefacts and never ship.

## Scope

Read-only, by design.
Nothing here logs in, posts an advert, places a bid, messages a seller, adds to a cart, or buys.
Every tool is a GET and is annotated `readOnlyHint: true`.

Automated access may sit outside the site's terms of service.
You are responsible for how you use it. Keep request rates low and sane.

This is an unofficial client. It is not affiliated with, endorsed by, or supported by
Marktplaats or its owners.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: keep it read-only, keep request
rates low, and never commit a capture.

Security issues: see [SECURITY.md](SECURITY.md).

## License

[ISC](LICENSE).
