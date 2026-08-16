/**
 * Layer 2: the MCP server. A thin wrapper over ./client.
 *
 * Read-only by design. Every tool is a GET. Nothing here logs in, posts,
 * bids, messages a seller, or buys.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { MarktplaatsError, getListing, getSeller, searchListings } from "./client.js";

const VERSION = "0.1.0";

const CONDITIONS = ["new", "like_new", "refurbished", "used", "not_working"] as const;
const SORTS = ["relevance", "newest", "oldest", "price_asc", "price_desc"] as const;

/** Shape every tool result the same way: JSON text plus structured content. */
function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function fail(err: unknown) {
  const message =
    err instanceof MarktplaatsError
      ? err.message
      : `Unexpected error: ${(err as Error).message ?? String(err)}`;
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function build(): McpServer {
  const server = new McpServer(
    { name: "marktplaats", version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "search_listings",
    {
      title: "Search marktplaats.nl",
      description:
        "Search marktplaats.nl (Dutch classifieds) for products. Returns price, condition, " +
        "delivery, category specs, location and seller for each hit. " +
        'delivery is "shipping", "pickup", "both" (seller offers either) or "unknown". ' +
        "Paid placements are included and flagged with isSponsored. " +
        "Prices are euros; priceEur is null when a listing takes bids or names no price.",
      inputSchema: z.object({
        query: z.string().min(1).describe('What to search for, e.g. "iphone 15" or "racefiets".'),
        limit: z.number().int().min(1).max(100).optional().describe("Max results. Default 30."),
        offset: z.number().int().min(0).optional().describe("Skip this many results, for paging."),
        sortBy: z
          .enum(SORTS)
          .optional()
          .describe("Result order. Default relevance."),
        minPriceEur: z.number().min(0).optional().describe("Lowest asking price in euros."),
        maxPriceEur: z.number().min(0).optional().describe("Highest asking price in euros."),
        condition: z
          .array(z.enum(CONDITIONS))
          .optional()
          .describe("Keep only these conditions. Several may be given."),
        delivery: z
          .enum(["shipping", "pickup"])
          .optional()
          .describe(
            'Filter by delivery. "shipping" also keeps listings marked "both", because ' +
              "those sellers will ship. Only these two values are filterable.",
          ),
        postcode: z
          .string()
          .optional()
          .describe('Dutch postcode to measure distance from, e.g. "1011AB".'),
        distanceKm: z
          .number()
          .min(1)
          .optional()
          .describe("Only listings within this many km of postcode. Needs postcode."),
        searchInDescription: z
          .boolean()
          .optional()
          .describe("Match the query in listing bodies too, not only titles. Default true."),
        onlyWithPrice: z
          .boolean()
          .optional()
          .describe(
            "Drop listings with no asking price: wanted-ads, trades, giveaways and open-bid " +
              'auctions. Set this whenever you sort by "price_asc", which otherwise returns ' +
              "every zero-price listing first. Default false.",
          ),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return ok(await searchListings(args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_listing",
    {
      title: "Get one marktplaats.nl listing",
      description:
        "Fetch full detail for one listing by id or URL. Adds what search does not carry: " +
        "shipping carrier and transit days, view and favourite counts, listed-since date, " +
        "seller tenure, category path, bidding and reserved state, and the full description.",
      inputSchema: z.object({
        listing: z
          .string()
          .min(2)
          .describe('Listing id such as "a1517154667", or a full marktplaats.nl/v/... URL.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ listing }) => {
      try {
        return ok(await getListing(listing));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_seller",
    {
      title: "Get a marktplaats.nl seller profile",
      description:
        "Fetch a seller's public profile by numeric seller id, as returned in search results. " +
        "Useful for judging whether a seller is a private person or a shop.",
      inputSchema: z.object({
        sellerId: z.union([z.number(), z.string()]).describe("Numeric seller id from a listing."),
        sellerName: z.string().optional().describe("Seller display name, if you have it."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ sellerId, sellerName }) => {
      try {
        return ok(await getSeller(sellerId, sellerName));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}

serveStdio(build);
