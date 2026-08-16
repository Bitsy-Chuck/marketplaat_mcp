/**
 * Phase 5 verification: call every client function against the live site and
 * assert on the BODY, not the status code.
 *
 * Read-only. Run: node verify.mjs
 */

import { getListing, getSeller, searchListings } from "../dist/client.js";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` -- ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("=== T1 search_listings: basic ===");
const r1 = await searchListings({ query: "racefiets", limit: 10 });
check("returns exactly the requested limit", r1.returned === 10, `returned=${r1.returned}`);
check("totalResultCount is large", r1.totalResultCount > 1000, `total=${r1.totalResultCount}`);
check("every listing has an id", r1.listings.every((l) => /^[am]\d+$/.test(l.id)));
check("every listing has a title", r1.listings.every((l) => l.title.length > 0));
check("every listing has an absolute url", r1.listings.every((l) => l.url.startsWith("https://")));
check(
  "delivery is a known enum",
  r1.listings.every((l) => ["shipping", "pickup", "both", "unknown"].includes(l.delivery)),
);
check(
  "condition is a known enum",
  r1.listings.every((l) => ["new", "like_new", "refurbished", "used", "not_working", "unknown"].includes(l.condition)),
);
const withDelivery = r1.listings.filter((l) => l.delivery !== "unknown");
check("at least some listings report delivery", withDelivery.length > 0, `${withDelivery.length}/10`);
const DUTCH_FOR = { shipping: "Verzenden", pickup: "Ophalen", both: "Ophalen of Verzenden" };
check(
  "delivery raw matches english",
  withDelivery.every((l) => DUTCH_FOR[l.delivery] === l.deliveryRaw),
  [...new Set(withDelivery.map((l) => `${l.delivery}=${l.deliveryRaw}`))].join(", "),
);
check("sponsoredType is valid", r1.listings.every((l) => [null, "dagtopper", "admarkt"].includes(l.sponsoredType)));
check("isSponsored agrees with sponsoredType", r1.listings.every((l) => l.isSponsored === (l.sponsoredType !== null)));

await sleep(1200);
console.log("\n=== T2 search_listings: price filter actually filters ===");
const r2 = await searchListings({ query: "racefiets", limit: 20, minPriceEur: 500, maxPriceEur: 1500 });
const priced = r2.listings.filter((l) => l.priceEur !== null);
check("price filter narrows the result count", r2.totalResultCount < r1.totalResultCount,
  `${r2.totalResultCount} < ${r1.totalResultCount}`);
check(
  "every priced listing is inside the range",
  priced.every((l) => l.priceEur >= 500 && l.priceEur <= 1500),
  `checked ${priced.length}, out of range: ${priced.filter((l) => l.priceEur < 500 || l.priceEur > 1500).map((l) => l.priceEur).join(",") || "none"}`,
);
check("server echoed the range back", JSON.stringify(r2.appliedFilters.priceRange).includes("PriceCents"),
  JSON.stringify(r2.appliedFilters.priceRange));

await sleep(1200);
console.log("\n=== T3 search_listings: sort actually sorts ===");
const asc = await searchListings({ query: "racefiets", limit: 15, sortBy: "price_asc", minPriceEur: 100 });
const ascPrices = asc.listings.filter((l) => l.priceEur !== null).map((l) => l.priceEur);
const isSorted = ascPrices.every((v, i, a) => i === 0 || a[i - 1] <= v);
check("price_asc returns non-decreasing prices", isSorted, `[${ascPrices.slice(0, 6).join(", ")}]`);

await sleep(1200);
const desc = await searchListings({ query: "racefiets", limit: 5, sortBy: "price_desc" });
const descPrices = desc.listings.filter((l) => l.priceEur !== null).map((l) => l.priceEur);
check("price_desc starts higher than price_asc", (descPrices[0] ?? 0) > (ascPrices[0] ?? 0),
  `${descPrices[0]} > ${ascPrices[0]}`);

await sleep(1200);
console.log("\n=== T4 search_listings: delivery filter ===");
// Use a category that actually carries the delivery attribute, so this is a
// real assertion and not vacuously true on an empty set.
const ship = await searchListings({ query: "iphone 15", limit: 30, delivery: "shipping" });
const known = ship.listings.filter((l) => l.delivery !== "unknown");
check("shipping filter narrows results", ship.totalResultCount < r1.totalResultCount,
  `${ship.totalResultCount} < ${r1.totalResultCount}`);
check("the filtered set is non-empty and typed", known.length >= 10, `${known.length}/30 with known delivery`);
check(
  "no pickup-only listings leak through",
  known.every((l) => l.delivery === "shipping" || l.delivery === "both"),
  `values: ${[...new Set(known.map((l) => l.delivery))].join(", ")}`,
);

await sleep(1200);
console.log("\n=== T4b delivery vocabulary is fully mapped ===");
const mix = await searchListings({ query: "iphone 15", limit: 30 });
const unknownDelivery = mix.listings.filter((l) => l.delivery === "unknown" && l.deliveryRaw);
check(
  "no Dutch delivery value is left unmapped",
  unknownDelivery.length === 0,
  unknownDelivery.length ? `unmapped: ${[...new Set(unknownDelivery.map((l) => l.deliveryRaw))].join(", ")}` : "all mapped",
);
check(
  '"both" is present and mapped',
  mix.listings.some((l) => l.delivery === "both"),
  `${mix.listings.filter((l) => l.delivery === "both").length}/30 are both`,
);

await sleep(1200);
console.log("\n=== T5 search_listings: condition filter ===");
const nieuw = await searchListings({ query: "racefiets", limit: 15, condition: ["new"] });
const kc = nieuw.listings.filter((l) => l.condition !== "unknown");
check("condition filter narrows results", nieuw.totalResultCount < r1.totalResultCount,
  `${nieuw.totalResultCount} < ${r1.totalResultCount}`);
check("only 'new' comes back", kc.every((l) => l.condition === "new"), `${kc.length} with known condition`);

await sleep(1200);
console.log("\n=== T6 search_listings: postcode distance ===");
const near = await searchListings({ query: "racefiets", limit: 10, postcode: "1011AB", distanceKm: 5 });
check("distance filter narrows results", near.totalResultCount < r1.totalResultCount,
  `${near.totalResultCount} < ${r1.totalResultCount}`);
check("server echoed the postcode", near.appliedFilters.postcode === "1011AB", String(near.appliedFilters.postcode));

await sleep(1200);
console.log("\n=== T7 search_listings: specs are populated ===");
const phones = await searchListings({ query: "iphone 15", limit: 15 });
const withSpecs = phones.listings.filter((l) => Object.keys(l.specs).length > 0);
check("most phone listings carry specs", withSpecs.length >= 8, `${withSpecs.length}/15 have specs`);
check(
  "specs contain real category attributes",
  withSpecs.some((l) => "storage" in l.specs || "type" in l.specs || "model" in l.specs),
  JSON.stringify(withSpecs[0]?.specs ?? {}),
);

await sleep(1200);
console.log("\n=== T8 search_listings: paging ===");
const p0 = await searchListings({ query: "racefiets", limit: 10, offset: 0, sortBy: "newest" });
await sleep(1200);
const p1 = await searchListings({ query: "racefiets", limit: 10, offset: 10, sortBy: "newest" });
const overlap = p0.listings.filter((a) => p1.listings.some((b) => b.id === a.id)).length;
check("page 2 is mostly different from page 1", overlap <= 2, `${overlap} shared ids`);

await sleep(1200);
console.log("\n=== T9 get_listing: real detail ===");
const target = phones.listings.find((l) => l.priceEur !== null) ?? phones.listings[0];
const d = await getListing(target.id);
check("id round-trips", d.id === target.id, `${d.id} vs ${target.id}`);
check("has a title", d.title.length > 0, d.title.slice(0, 50));
check("has a category path", Boolean(d.categoryPath), String(d.categoryPath));
check("has a view count", typeof d.viewCount === "number", String(d.viewCount));
check("has a listed-since date", Boolean(d.listedSince), String(d.listedSince));
check("has a description", d.description.length > 20, `${d.description.length} chars`);
check("has specs from the detail page", Object.keys(d.specs).length > 0, JSON.stringify(d.specs));
check("delivery resolved", d.delivery !== "unknown", `${d.delivery} (${d.deliveryRaw})`);
check("price matches the search result", d.priceEur === target.priceEur, `${d.priceEur} vs ${target.priceEur}`);
check("seller name present", Boolean(d.sellerName), String(d.sellerName));

await sleep(1200);
console.log("\n=== T10 get_listing: accepts a full URL ===");
const d2 = await getListing(target.url);
check("URL form returns the same listing", d2.id === target.id, `${d2.id}`);

await sleep(1200);
console.log("\n=== T11 get_seller ===");
const sellerListing = phones.listings.find((l) => l.sellerId);
try {
  const s = await getSeller(sellerListing.sellerId, sellerListing.sellerName ?? undefined);
  check("seller profile returns an object", s && typeof s.raw === "object", `keys=${Object.keys(s.raw).slice(0, 6)}`);
} catch (err) {
  check("seller profile returns an object", false, err.message);
}

await sleep(1200);
console.log("\n=== T12 error handling ===");
try {
  await getListing("a9999999999999");
  check("missing listing raises a clear error", false, "no error thrown");
} catch (err) {
  check("missing listing raises a clear error", /not found|removed|listing data/i.test(err.message), err.message.slice(0, 80));
}
try {
  await searchListings({ query: "" });
  check("empty query is rejected", false, "no error thrown");
} catch (err) {
  check("empty query is rejected", /must not be empty/.test(err.message), err.message);
}

console.log(`\n${"=".repeat(56)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) console.log("Failures:\n  - " + failures.join("\n  - "));
process.exit(fail ? 1 : 0);
