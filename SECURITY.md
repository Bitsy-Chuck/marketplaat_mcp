# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, rather than opening a public issue.

## What this project handles

**No credentials, by design.**
Every request is an unauthenticated public GET to marktplaats.nl.
There are no API keys, tokens, cookies or environment variables at runtime.
There is nothing to rotate and nothing to leak from a normal install.

**Network surface.**
The server talks to exactly one host, `www.marktplaats.nl`, over HTTPS.
It runs over stdio and opens no listening port.

**It does not execute site content.**
Responses are parsed as JSON and HTML. No browser runs at query time and no script from the
site is evaluated.

## The one real hazard: capture artefacts

The capture step, used only when re-recording after the site changes, drives a real browser
and writes a HAR to `captures/`.

**A HAR stores real request headers.** Yours will contain your own browser's consent, WAF and
analytics cookies. The capture script never logs in, so these are anonymous identifiers rather
than account credentials, but they still identify your browser session, and a WAF token is
reusable.

`captures/`, `shots/` and `work/` are gitignored. Do not remove those entries, and never
`git add -f` them. If you publish a HAR by accident, treat the identifiers in it as burned and
clear the relevant cookies in the browser you recorded with.

## Scope note

This is an unofficial client. Automated access may sit outside the site's terms of service.
You are responsible for how you use it.
