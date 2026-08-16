/**
 * Call the marktplaats MCP server from the shell, over the real MCP stdio
 * protocol. Handy before a client has picked the server up.
 *
 * Usage:
 *   node ask.mjs search '{"query":"iphone 15 pro","maxPriceEur":500}'
 *   node ask.mjs listing a1517154667
 *   node ask.mjs seller 57429132
 */

import { spawn } from "node:child_process";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

const [, , cmd, ...rest] = process.argv;
if (!cmd) {
  console.error("usage: node ask.mjs <search|listing|seller> <json-args|id>");
  process.exit(2);
}

const TOOL = { search: "search_listings", listing: "get_listing", seller: "get_seller" }[cmd];
if (!TOOL) {
  console.error(`unknown command "${cmd}". Use search, listing or seller.`);
  process.exit(2);
}

const arg = rest.join(" ").trim();
let args;
if (cmd === "search") args = JSON.parse(arg || "{}");
else if (cmd === "listing") args = { listing: arg };
else args = { sellerId: arg };

const child = spawn("node", [new URL("../dist/server.js", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const pending = new Map();
child.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    } catch {
      /* not a complete json line */
    }
  }
});

let id = 1;
const rpc = (method, params) =>
  new Promise((res) => {
    const myId = id++;
    pending.set(myId, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });

await rpc("initialize", {
  protocolVersion: LATEST_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "ask", version: "1.0.0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const out = await rpc("tools/call", { name: TOOL, arguments: args });
child.kill();

if (out.error) {
  console.error("error:", out.error.message);
  process.exit(1);
}
const data = out.result?.structuredContent ?? JSON.parse(out.result?.content?.[0]?.text ?? "{}");

if (out.result?.isError) {
  console.error(out.result.content?.[0]?.text);
  process.exit(1);
}

// Pretty-print a search; dump JSON for anything else.
if (cmd === "search" && Array.isArray(data.listings)) {
  console.log(`\n${data.totalResultCount} matches, showing ${data.returned}\n`);
  for (const l of data.listings) {
    const flag = l.isSponsored ? `[${l.sponsoredType}]` : "";
    console.log(`${l.priceLabel.padEnd(12)} ${l.condition.padEnd(12)} ${l.delivery.padEnd(9)} ${flag}`);
    console.log(`  ${l.title}`);
    const specs = Object.entries(l.specs)
      .map(([k, v]) => `${k}: ${v}`)
      .join("  ·  ");
    if (specs) console.log(`  ${specs}`);
    console.log(`  ${l.city ?? "location n/a"}  ·  ${l.sellerName}  ·  ${l.id}`);
    console.log(`  ${l.url}\n`);
  }
} else {
  console.log(JSON.stringify(data, null, 2));
}
