/**
 * End-to-end MCP check: spawn the built server over stdio and speak raw
 * JSON-RPC to it. Proves the wire protocol works, not just the client library.
 *
 * Run: node smoke-mcp.mjs
 */

import { spawn } from "node:child_process";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";

const child = spawn("node", [new URL("../dist/server.js", import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.on("data", (b) => process.stderr.write(`[server] ${b}`));

let buf = "";
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 45000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` -- ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

try {
  console.log("=== initialize ===");
  const init = await rpc("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0.0" },
  });
  check("server initializes", Boolean(init.result), JSON.stringify(init.result?.serverInfo));
  notify("notifications/initialized");

  console.log("\n=== tools/list ===");
  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  check("exposes 3 tools", names.length === 3, names.join(", "));
  check("search_listings present", names.includes("search_listings"));
  check("get_listing present", names.includes("get_listing"));
  check("get_seller present", names.includes("get_seller"));
  const search = list.result.tools.find((t) => t.name === "search_listings");
  check("search tool has an input schema", Boolean(search?.inputSchema?.properties?.query));
  check("search tool is marked read-only", search?.annotations?.readOnlyHint === true);

  console.log("\n=== tools/call search_listings ===");
  const call = await rpc("tools/call", {
    name: "search_listings",
    arguments: { query: "racefiets", limit: 5, maxPriceEur: 400, sortBy: "price_desc" },
  });
  check("call succeeded", !call.result?.isError, call.result?.isError ? call.result.content?.[0]?.text : "");
  const payload = call.result?.structuredContent ?? JSON.parse(call.result?.content?.[0]?.text ?? "{}");
  check("returned 5 listings", payload.listings?.length === 5, `got ${payload.listings?.length}`);
  check("respects the max price", payload.listings.every((l) => l.priceEur === null || l.priceEur <= 400),
    `max seen: ${Math.max(...payload.listings.map((l) => l.priceEur ?? 0))}`);
  const sample = payload.listings[0];
  console.log("  sample:", JSON.stringify({
    title: sample.title.slice(0, 44),
    priceLabel: sample.priceLabel,
    condition: sample.condition,
    delivery: sample.delivery,
    city: sample.city,
    isSponsored: sample.isSponsored,
  }));

  console.log("\n=== tools/call get_listing ===");
  const one = await rpc("tools/call", { name: "get_listing", arguments: { listing: sample.id } });
  check("detail call succeeded", !one.result?.isError, one.result?.isError ? one.result.content?.[0]?.text : "");
  const detail = one.result?.structuredContent ?? {};
  check("detail has category path", Boolean(detail.categoryPath), String(detail.categoryPath));
  check("detail has view count", typeof detail.viewCount === "number", String(detail.viewCount));

  console.log("\n=== tools/call with a bad argument ===");
  const bad = await rpc("tools/call", { name: "search_listings", arguments: { query: "" } });
  check("empty query is rejected cleanly", Boolean(bad.error) || bad.result?.isError === true,
    bad.error?.message ?? bad.result?.content?.[0]?.text?.slice(0, 60));
} catch (err) {
  console.error("FATAL:", err.message);
  fail++;
} finally {
  child.kill();
}

console.log(`\n${"=".repeat(56)}`);
console.log(`MCP SMOKE: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
