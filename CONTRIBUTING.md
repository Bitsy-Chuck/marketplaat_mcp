# Contributing

Thanks for taking a look. This is a small, deliberately narrow project.

## Ground rules

**Read-only, always.**
Nothing here logs in, posts an advert, places a bid, messages a seller, adds to a cart, or buys.
Every tool is a GET and is annotated `readOnlyHint: true`.
A change that breaks this will not be merged, however useful it seems.

**Keep request rates low and sane.**
This reads an internal API on a live consumer site.
Do not add polling, prefetching, or parallel fan-out.
Do not add a feature whose normal use means hammering the site.

**Never commit a capture.**
`captures/`, `shots/` and `work/` are gitignored and must stay that way.
A HAR records real request headers, so it carries your own consent, WAF and analytics cookies.
The capture script never logs in, so these are anonymous identifiers rather than account
credentials, but they still identify your browser session.

## Setup

Requires Node.js 20 or newer.

```bash
npm install
npm run build
```

## Tests

```bash
npm test            # everything below
npm run test:client # client checks against the live site
npm run test:mcp    # checks over the real MCP stdio protocol
```

Both suites hit the live site, so they need network access and take about a minute.
They are read-only and safe to run, but do not run them in a loop.

CI reflects this split. `ci.yml` runs type check and build on every push and never touches the
site. `live-check.yml` runs the live suites weekly, as an early warning that the site changed.

## Making a change

1. Open an issue first for anything beyond a bug fix, so we can agree the shape.
2. Keep `client.ts` and `server.ts` separate. `client.ts` is the typed HTTP layer and knows
   nothing about MCP. `server.ts` is the MCP surface and contains no parsing.
3. If you add a field, add it to the README tool tables too.
4. If you learn something surprising about the site, put it in "Field notes" in the README.
   That section is the most valuable part of this repo.
5. Run `npm run typecheck` and `npm test` before opening a PR.

## When the site changes

Tools failing usually means marktplaats.nl changed, not that this code regressed.

Re-record the capture and re-check the parsing. See "Re-recording" in the README.
Then update the capture date in the README "Status" section.

## Commit messages

Short imperative subject, 50 characters where possible and 72 at the outside.
Blank line, then a body wrapped at 72 explaining what changed and why.
The diff already shows how.
