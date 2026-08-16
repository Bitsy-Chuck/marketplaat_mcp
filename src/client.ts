/**
 * Layer 1: a typed HTTP client for marktplaats.nl.
 *
 * Read-only. It calls the site's own internal JSON search API and parses the
 * embedded JSON on listing detail pages. It never logs in, posts, bids, or buys.
 *
 * Discovered by recording the site's traffic on 2026-08-16. See README.md.
 */

import process from "node:process";

const ORIGIN = "https://www.marktplaats.nl";
const SEARCH_API = `${ORIGIN}/lrp/api/search`;
const SELLER_API = `${ORIGIN}/v/api/seller-profile`;

/** Browsers send these; the site is fine without them, but they keep us honest. */
const HEADERS: Record<string, string> = {
  Accept: "application/json, text/html;q=0.9,*/*;q=0.8",
  "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

// ---------------------------------------------------------------------------
// Vocabulary. Dutch on the wire, English in the API, raw kept alongside.
// Attribute ids confirmed against the live facets on 2026-08-16.
// ---------------------------------------------------------------------------

export type Condition = "new" | "like_new" | "refurbished" | "used" | "not_working" | "unknown";
/** "both" is the site's most common value ("Ophalen of Verzenden"). */
export type Delivery = "shipping" | "pickup" | "both" | "unknown";
export type SortBy = "relevance" | "newest" | "oldest" | "price_asc" | "price_desc";

const CONDITION_ID: Record<Exclude<Condition, "unknown">, number> = {
  new: 30,
  refurbished: 14050,
  like_new: 31,
  used: 32,
  not_working: 13940,
};

/**
 * Only two delivery values are filterable. Filtering by shipping also returns
 * listings marked "both", which is correct: those sellers will ship.
 */
const DELIVERY_ID: Record<"pickup" | "shipping", number> = {
  pickup: 33,
  shipping: 34,
};

const CONDITION_FROM_DUTCH: Record<string, Condition> = {
  Nieuw: "new",
  "Zo goed als nieuw": "like_new",
  Refurbished: "refurbished",
  Gebruikt: "used",
  "Niet werkend": "not_working",
};

const DELIVERY_FROM_DUTCH: Record<string, Delivery> = {
  Verzenden: "shipping",
  Ophalen: "pickup",
  "Ophalen of Verzenden": "both",
};

const SORT: Record<SortBy, { sortBy: string; sortOrder: string } | null> = {
  relevance: null,
  newest: { sortBy: "SORT_INDEX", sortOrder: "DECREASING" },
  oldest: { sortBy: "SORT_INDEX", sortOrder: "INCREASING" },
  price_asc: { sortBy: "PRICE", sortOrder: "INCREASING" },
  price_desc: { sortBy: "PRICE", sortOrder: "DECREASING" },
};

/** priceType values the site uses. Unknown values pass through untranslated. */
const PRICE_TYPE_LABEL: Record<string, string> = {
  FIXED: "fixed price",
  BIDDING: "bidding",
  MIN_BID: "minimum bid",
  NOTK: "price on request",
  SEE_DESCRIPTION: "see description",
  FREE: "free",
  RESERVED: "reserved",
  EXCHANGE: "exchange",
  FAST_BID: "fast bid",
};

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface Listing {
  id: string;
  title: string;
  url: string;
  /** Euros. null when the listing has no fixed asking price (bidding, free, on request). */
  priceEur: number | null;
  priceType: string;
  priceLabel: string;
  condition: Condition;
  conditionRaw: string | null;
  delivery: Delivery;
  deliveryRaw: string | null;
  /** Category-specific specs, English-keyed by the site (storage, model, ...). */
  specs: Record<string, string>;
  description: string;
  city: string | null;
  distanceKm: number | null;
  sellerName: string | null;
  sellerId: number | null;
  postedLabel: string | null;
  imageUrl: string | null;
  /** True for any paid placement. The site has two kinds; see sponsoredType. */
  isSponsored: boolean;
  /**
   * "dagtopper" is a boosted private listing ("Topadvertentie" on the site).
   * "admarkt" is a professional-seller advert. null means an organic result.
   */
  sponsoredType: "dagtopper" | "admarkt" | null;
  isReserved: boolean;
}

export interface SearchResult {
  query: string;
  totalResultCount: number;
  returned: number;
  offset: number;
  listings: Listing[];
  /** Filters the site applied, echoed back so you can confirm they took effect. */
  appliedFilters: Record<string, unknown>;
}

export interface ListingDetail extends Listing {
  categoryPath: string | null;
  categoryId: number | null;
  viewCount: number | null;
  favouritedCount: number | null;
  listedSince: string | null;
  shippingCarrier: string | null;
  shippingCostLabel: string | null;
  transitDaysMin: number | null;
  transitDaysMax: number | null;
  shippable: boolean | null;
  buyItNowEnabled: boolean | null;
  biddingEnabled: boolean | null;
  bidCount: number | null;
  availability: string | null;
  sellerActiveSince: string | null;
  sellerProfileUrl: string | null;
  averageCo2Kg: number | null;
  imageUrls: string[];
}

export interface SearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  sortBy?: SortBy;
  minPriceEur?: number;
  maxPriceEur?: number;
  condition?: Condition[];
  delivery?: Delivery;
  postcode?: string;
  distanceKm?: number;
  /** Also match the query against listing bodies, not just titles. Default true. */
  searchInDescription?: boolean;
  /**
   * Drop listings with no asking price: wanted-ads, trades, giveaways and
   * open-bid auctions. Worth setting with sortBy "price_asc", which otherwise
   * returns every zero-price listing first.
   */
  onlyWithPrice?: boolean;
}

export class MarktplaatsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "MarktplaatsError";
  }
}

// ---------------------------------------------------------------------------
// Rate limiting
//
// This reads an internal API on a live consumer site, so it has to behave like
// a polite client rather than a crawler. Two mechanisms:
//
//   1. Requests are serialised with a minimum gap between them. Concurrent
//      callers queue instead of fanning out, so an agent firing eight searches
//      at once still produces one orderly stream.
//   2. Throttling and transient server errors are retried with exponential
//      backoff, honouring Retry-After when the site sends it.
//
// Both are tunable by environment variable, but the defaults are deliberately
// conservative. If bulk work feels slow, do less of it rather than turning the
// gap down.
// ---------------------------------------------------------------------------

/** Read a bounded integer from the environment, falling back when unusable. */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** Minimum gap between the starts of two requests. */
const MIN_INTERVAL_MS = envInt("MARKTPLAATS_MIN_INTERVAL_MS", 1000, 0, 60_000);
/** Retries after the first attempt, for throttling and transient errors. */
const MAX_RETRIES = envInt("MARKTPLAATS_MAX_RETRIES", 3, 0, 10);
/** Worth retrying: throttling, and the transient 5xx family. */
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tail of the request queue. Each request waits for the previous one. */
let queue: Promise<unknown> = Promise.resolve();
let lastStartedAt = 0;

/** Run fn once the queue drains and the minimum interval has elapsed. */
function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastStartedAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStartedAt = Date.now();
    return fn();
  });
  // Swallow the result on the queue chain so one failure cannot break the
  // queue for every later caller. The real outcome still reaches `run`.
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Delay before retry `attempt` (0-based), honouring Retry-After if present. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) {
      return Math.min(Math.max(at - Date.now(), 0), MAX_BACKOFF_MS);
    }
  }
  // Exponential, with jitter so parallel clients do not resynchronise.
  const base = Math.max(MIN_INTERVAL_MS, 500) * 2 ** attempt;
  return Math.min(base + Math.random() * 250, MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function get(url: string, accept: "json" | "html"): Promise<unknown> {
  let lastNetworkError: MarktplaatsError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await schedule(() => fetch(url, { headers: HEADERS, redirect: "follow" }));
    } catch (cause) {
      lastNetworkError = new MarktplaatsError(
        `Network request to marktplaats.nl failed: ${(cause as Error).message}`,
        undefined,
        url,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw lastNetworkError;
    }

    if (res.ok) return accept === "json" ? res.json() : res.text();

    if (RETRY_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      await sleep(backoffMs(attempt, res.headers.get("retry-after")));
      continue;
    }

    throw new MarktplaatsError(
      res.status === 404
        ? "Listing not found. It was probably removed or sold."
        : res.status === 429
          ? `marktplaats.nl throttled this client (HTTP 429) and it did not clear after ${MAX_RETRIES} retries. Send fewer requests, or raise MARKTPLAATS_MIN_INTERVAL_MS.`
          : `marktplaats.nl returned HTTP ${res.status}. If this persists the site changed; re-record the capture (see README).`,
      res.status,
      url,
    );
  }

  /* istanbul ignore next: the loop always returns or throws before here. */
  throw lastNetworkError ?? new MarktplaatsError("Request to marktplaats.nl failed", undefined, url);
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

type RawAttr = { key?: string; value?: string };

function attrValue(attrs: RawAttr[] | undefined, key: string): string | null {
  const hit = attrs?.find((a) => a.key === key);
  return hit?.value ?? null;
}

function toSpecs(attrs: RawAttr[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of attrs ?? []) {
    // condition and delivery get first-class fields; do not duplicate them here.
    if (!a.key || !a.value || a.key === "condition" || a.key === "delivery") continue;
    out[a.key] = a.value;
  }
  return out;
}

function absolute(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return ORIGIN + url;
  return url;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function normaliseListing(raw: any): Listing {
  const cents = raw?.priceInfo?.priceCents;
  const priceType: string = raw?.priceInfo?.priceType ?? "UNKNOWN";
  // The site uses 0 cents as a placeholder for "no asking price".
  const hasPrice = typeof cents === "number" && cents > 0;

  const conditionRaw = attrValue(raw?.attributes, "condition") ?? attrValue(raw?.extendedAttributes, "condition");
  const deliveryRaw = attrValue(raw?.attributes, "delivery") ?? attrValue(raw?.extendedAttributes, "delivery");
  const distanceMeters = raw?.location?.distanceMeters;

  // Two separate paid-placement signals, confirmed against live results:
  // priorityProduct=DAGTOPPER is a boosted listing; an Admarkt advert instead
  // carries a sellerWebsiteUrl pointing at admarkt.marktplaats.nl.
  const sponsoredType: "dagtopper" | "admarkt" | null =
    raw?.priorityProduct && raw.priorityProduct !== "NONE"
      ? "dagtopper"
      : String(raw?.sellerInformation?.sellerWebsiteUrl ?? "").includes("admarkt")
        ? "admarkt"
        : null;

  return {
    id: String(raw?.itemId ?? ""),
    title: String(raw?.title ?? ""),
    url: absolute(raw?.vipUrl) ?? "",
    priceEur: hasPrice ? cents / 100 : null,
    priceType,
    priceLabel: hasPrice
      ? `EUR ${(cents / 100).toFixed(2)}`
      : (PRICE_TYPE_LABEL[priceType] ?? priceType.toLowerCase().replace(/_/g, " ")),
    condition: conditionRaw ? (CONDITION_FROM_DUTCH[conditionRaw] ?? "unknown") : "unknown",
    conditionRaw,
    delivery: deliveryRaw ? (DELIVERY_FROM_DUTCH[deliveryRaw] ?? "unknown") : "unknown",
    deliveryRaw,
    specs: { ...toSpecs(raw?.extendedAttributes), ...toSpecs(raw?.attributes) },
    description: String(raw?.categorySpecificDescription ?? raw?.description ?? ""),
    city: raw?.location?.cityName ?? null,
    // -1000 is the site's sentinel for "no distance known".
    distanceKm:
      typeof distanceMeters === "number" && distanceMeters >= 0
        ? Math.round(distanceMeters / 100) / 10
        : null,
    sellerName: raw?.sellerInformation?.sellerName ?? null,
    sellerId: raw?.sellerInformation?.sellerId ?? null,
    postedLabel: raw?.date ?? null,
    imageUrl: absolute(raw?.imageUrls?.[0]),
    isSponsored: sponsoredType !== null,
    sponsoredType,
    isReserved: Boolean(raw?.reserved),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Tool 1: search
// ---------------------------------------------------------------------------

export async function searchListings(opts: SearchOptions): Promise<SearchResult> {
  const query = opts.query?.trim();
  if (!query) throw new MarktplaatsError("query must not be empty");

  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  const p = new URLSearchParams();
  p.set("query", query);
  p.set("limit", String(limit));
  p.set("offset", String(offset));
  p.set("searchInTitleAndDescription", String(opts.searchInDescription ?? true));
  p.set("viewOptions", "list-view");

  const sort = SORT[opts.sortBy ?? "relevance"];
  if (sort) {
    p.set("sortBy", sort.sortBy);
    p.set("sortOrder", sort.sortOrder);
  }

  // Price is a range facet, not a plain from/to pair. PriceCentsFrom is ignored
  // by the server; attributeRanges[] is the form that actually filters.
  // A floor of 1 cent is also how you exclude the no-asking-price listings:
  // the site stores those as 0, so any range starting at 1 drops them.
  if (opts.minPriceEur != null || opts.maxPriceEur != null || opts.onlyWithPrice) {
    const floor = opts.onlyWithPrice ? 1 : 0;
    const from = Math.max(Math.round((opts.minPriceEur ?? 0) * 100), floor);
    const to = Math.round((opts.maxPriceEur ?? 1_000_000) * 100);
    p.append("attributeRanges[]", `PriceCents:${from}:${to}`);
  }

  for (const c of opts.condition ?? []) {
    const id = CONDITION_ID[c as Exclude<Condition, "unknown">];
    if (id) p.append("attributesById[]", String(id));
  }

  if (opts.delivery === "shipping" || opts.delivery === "pickup") {
    p.append("attributesById[]", String(DELIVERY_ID[opts.delivery]));
  }

  if (opts.postcode) {
    p.set("postcode", opts.postcode.replace(/\s+/g, "").toUpperCase());
    if (opts.distanceKm != null) p.set("distanceMeters", String(Math.round(opts.distanceKm * 1000)));
  }

  const url = `${SEARCH_API}?${p.toString()}`;
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const data = (await get(url, "json")) as any;

  if (data?.hasErrors) {
    throw new MarktplaatsError("marktplaats.nl reported a search error for this query", undefined, url);
  }

  // The API over-delivers: it injects sponsored placements on top of `limit`,
  // so limit=3 can return 18. Slice back to what was asked for, keeping the
  // site's own ordering.
  const all = Array.isArray(data?.listings) ? data.listings : [];
  const listings = all.slice(0, limit).map(normaliseListing);

  const req = data?.searchRequest ?? {};
  return {
    query,
    totalResultCount: data?.totalResultCount ?? 0,
    returned: listings.length,
    offset,
    listings,
    appliedFilters: {
      sortBy: opts.sortBy ?? "relevance",
      priceRange: req.attributeRanges ?? [],
      attributeIds: req.attributesById ?? [],
      postcode: req.distance?.postcode || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool 2: listing detail
// ---------------------------------------------------------------------------

/** Pull `window.__CONFIG__ = {...};` out of a detail page using brace matching. */
function extractConfig(html: string): Record<string, unknown> | null {
  const marker = "window.__CONFIG__ = ";
  const i = html.indexOf(marker);
  if (i === -1) return null;
  const start = i + marker.length;
  // Scan forward counting braces, skipping string literals, to find the end.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = start; j < html.length; j++) {
    const ch = html[j];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function extractJsonLd(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      Array.isArray(parsed) ? out.push(...parsed) : out.push(parsed);
    } catch {
      /* a malformed block is not fatal */
    }
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function decodeEntities(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/&euro;/g, "EUR")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The spec table and description are rendered as HTML, not embedded JSON, so
 * these two are the only DOM-shaped reads in the client. They are the first
 * thing to break if the site restyles; everything else comes from JSON.
 */
function extractAttributesFromDom(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re =
    /<div class="Attributes-module-item"><div class="Attributes-module-label">([\s\S]*?)<\/div><div class="Attributes-module-value">([\s\S]*?)<\/div><\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = decodeEntities(m[1]);
    const value = decodeEntities(m[2]);
    if (label && value) out[label] = value;
  }
  return out;
}

function extractDescriptionFromDom(html: string): string {
  const m = html.match(/class="[^"]*Description-module-description[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  return m ? decodeEntities(m[1]) : "";
}

/** Accepts a full listing URL, a path, or a bare item id such as `a1517154667`. */
function detailUrl(idOrUrl: string): string {
  const v = idOrUrl.trim();
  if (v.startsWith("http")) return v;
  if (v.startsWith("/")) return ORIGIN + v;
  // A bare item id resolves through the site's own short form, which 302s to
  // the canonical /v/<category>/<slug> URL. Verified live on 2026-08-16.
  if (/^[am]\d+$/i.test(v)) return `${ORIGIN}/${v}`;
  throw new MarktplaatsError(
    `Not a listing id or URL: ${idOrUrl}. Expect something like "a1517154667" or a full marktplaats.nl/v/... URL.`,
  );
}

export async function getListing(idOrUrl: string): Promise<ListingDetail> {
  const url = detailUrl(idOrUrl);
  const html = (await get(url, "html")) as string;

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const cfg = extractConfig(html) as any;
  const l = cfg?.listing;
  if (!l) {
    throw new MarktplaatsError(
      "Could not find listing data in the page. The listing may be removed, or marktplaats.nl changed its page structure; re-record the capture (see README).",
      undefined,
      url,
    );
  }

  const ld = extractJsonLd(html);
  const product = ld.find((x) => x?.["@type"] === "Product");
  const offer = product?.offers;
  const transit = offer?.shippingDetails?.deliveryTime?.transitTime;
  const label = l.shippingInformation?.augmentedLabels?.[0]?.labels?.[0];
  const deliveryRaw: string | null = l.shippingInformation?.deliveryType?.attributeValueLabel ?? null;

  const domAttrs = extractAttributesFromDom(html);
  const conditionRaw = domAttrs["Conditie"] ?? null;
  const specs: Record<string, string> = {};
  for (const [k, v] of Object.entries(domAttrs)) {
    if (k !== "Conditie" && k !== "Levering") specs[k] = v;
  }

  const cents = l.priceInfo?.priceCents;
  const priceType: string = l.priceInfo?.priceType ?? "UNKNOWN";
  const hasPrice = typeof cents === "number" && cents > 0;
  const images: string[] = (product?.image ?? []).filter((x: unknown) => typeof x === "string");

  return {
    id: String(l.itemId ?? ""),
    title: String(l.title ?? product?.name ?? ""),
    url,
    priceEur: hasPrice ? cents / 100 : null,
    priceType,
    priceLabel: hasPrice
      ? `EUR ${(cents / 100).toFixed(2)}`
      : (PRICE_TYPE_LABEL[priceType] ?? priceType.toLowerCase().replace(/_/g, " ")),
    condition: conditionRaw ? (CONDITION_FROM_DUTCH[conditionRaw] ?? "unknown") : "unknown",
    conditionRaw,
    delivery: deliveryRaw ? (DELIVERY_FROM_DUTCH[deliveryRaw] ?? "unknown") : "unknown",
    deliveryRaw,
    specs,
    description: extractDescriptionFromDom(html) || String(product?.description ?? ""),
    city: null,
    distanceKm: null,
    sellerName: l.seller?.name ?? null,
    sellerId: l.seller?.id ?? null,
    postedLabel: l.stats?.since ?? null,
    imageUrl: images[0] ?? null,
    isSponsored: l.adType === "Admarkt" || Boolean(l.flags?.isAdmarkt),
    sponsoredType: l.adType === "Admarkt" || l.flags?.isAdmarkt ? "admarkt" : null,
    isReserved: Boolean(l.isReserved),

    categoryPath: l.category?.fullName ?? null,
    categoryId: l.category?.id ?? null,
    viewCount: l.stats?.viewCount ?? null,
    favouritedCount: l.stats?.favoritedCount ?? null,
    listedSince: l.stats?.since ?? null,
    shippingCarrier: label?.carrierName || null,
    shippingCostLabel: label?.price || null,
    transitDaysMin: transit?.minValue ?? null,
    transitDaysMax: transit?.maxValue ?? null,
    shippable: l.flags?.shippable ?? null,
    buyItNowEnabled: l.buyItNowEnabled ?? null,
    biddingEnabled: l.bidsInfo?.isBiddingEnabled ?? null,
    bidCount: Array.isArray(l.bidsInfo?.bids) ? l.bidsInfo.bids.length : null,
    availability:
      typeof offer?.availability === "string" ? offer.availability.split("/").pop() : null,
    sellerActiveSince: l.seller?.activeSinceDiff ?? null,
    sellerProfileUrl: absolute(l.seller?.sellerProfileUrl),
    averageCo2Kg: l.averageCo2Kg ?? null,
    imageUrls: images,
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

// ---------------------------------------------------------------------------
// Tool 3: seller profile (the one true JSON endpoint the site exposes)
// ---------------------------------------------------------------------------

export interface SellerProfile {
  sellerId: number;
  raw: Record<string, unknown>;
}

export async function getSeller(sellerId: number | string, sellerName?: string): Promise<SellerProfile> {
  const p = new URLSearchParams();
  if (sellerName) p.set("sellerName", sellerName);
  const url = `${SELLER_API}/${encodeURIComponent(String(sellerId))}${p.toString() ? `?${p}` : ""}`;
  const raw = (await get(url, "json")) as Record<string, unknown>;
  return { sellerId: Number(sellerId), raw };
}
