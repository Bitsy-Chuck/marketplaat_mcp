# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this server reads a live consumer site, entries also record when the
capture was re-recorded. That date matters more than the version number when
diagnosing a breakage.

## [Unreleased]

## [0.1.0] - 2026-08-16

Initial release. Capture recorded 2026-08-16.

### Added

- `search_listings`, `get_listing` and `get_seller` over MCP stdio, all read-only.
- Typed HTTP client for the site's internal search API, seller profile API, and
  listing detail pages.
- Filters for price range, condition, delivery, postcode with distance, sorting,
  paging, and description search.
- Dutch source values preserved alongside translations as `conditionRaw` and
  `deliveryRaw`.
- Sponsored placements surfaced rather than hidden, via `isSponsored` and
  `sponsoredType`.
- Client-side enforcement of `limit`, because the search API injects sponsored
  rows on top of the requested count.
- Rate limiting: serialised requests with a minimum interval, plus retry with
  exponential backoff and `Retry-After` support. Tunable through
  `MARKTPLAATS_MIN_INTERVAL_MS` and `MARKTPLAATS_MAX_RETRIES`.
- Live test suites: 42 client checks and 14 MCP protocol checks.
- CI split by network use. Build and type check run per push; the live suites
  run weekly as an early warning that the site changed.

[Unreleased]: https://github.com/Bitsy-Chuck/marketplaat_mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Bitsy-Chuck/marketplaat_mcp/releases/tag/v0.1.0
