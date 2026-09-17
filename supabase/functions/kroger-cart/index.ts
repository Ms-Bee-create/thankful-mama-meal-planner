// Given a list of ingredient search terms (with quantities), finds matching
// Kroger products near the user's chosen store — preferring the cheapest
// non-organic match, since organic private-label items were getting picked
// by default — and adds them to the user's real Kroger cart.
//
// POST { items: ({ term: string, qty?: number } | string)[], zip?: string }
// Requires the user's Supabase JWT in the Authorization header.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const KROGER_CLIENT_ID = Deno.env.get("KROGER_CLIENT_ID")!;
const KROGER_CLIENT_SECRET = Deno.env.get("KROGER_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function refreshAccessToken(refreshToken: string) {
  const basicAuth = btoa(`${KROGER_CLIENT_ID}:${KROGER_CLIENT_SECRET}`);
  const res = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) throw new Error("Failed to refresh Kroger token: " + (await res.text()));
  return res.json();
}

// Products and Locations are public catalog data — Kroger wants those
// looked up with an app-level "client credentials" token, not the user's
// personal one. Only Cart actually needs the user's own token.
async function getAppToken() {
  const basicAuth = btoa(`${KROGER_CLIENT_ID}:${KROGER_CLIENT_SECRET}`);
  const res = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "product.compact",
    }),
  });
  if (!res.ok) throw new Error("Failed to get Kroger app token: " + (await res.text()));
  const data = await res.json();
  return data.access_token as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Not found" }, 404);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Not signed in" }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userErr } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (userErr || !userData.user) return json({ error: "Invalid session" }, 401);
  const userId = userData.user.id;

  const { items, zip } = await req.json();
  if (!Array.isArray(items) || !items.length) return json({ error: "No items provided" }, 400);

  const { data: connection, error: connErr } = await supabase
    .from("kroger_connections")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (connErr || !connection) return json({ error: "Kroger account not connected" }, 400);

  let accessToken = connection.access_token;
  let locationId = connection.kroger_location_id;

  // Refresh the token if it's expired or about to be.
  if (new Date(connection.expires_at).getTime() < Date.now() + 60_000) {
    const refreshed = await refreshAccessToken(connection.refresh_token);
    accessToken = refreshed.access_token;
    const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await supabase.from("kroger_connections").update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? connection.refresh_token,
      expires_at: expiresAt,
    }).eq("user_id", userId);
  }

  const appToken = await getAppToken();

  // Find the nearest store if we don't have one saved yet.
  if (!locationId) {
    if (!zip) return json({ error: "No store selected yet — need a zip code first" }, 400);
    const locRes = await fetch(
      `https://api.kroger.com/v1/locations?filter.zipCode.near=${encodeURIComponent(zip)}&filter.radiusInMiles=15&filter.limit=1`,
      { headers: { Authorization: `Bearer ${appToken}` } }
    );
    if (!locRes.ok) return json({ error: "Couldn't find a nearby Kroger store", detail: await locRes.text() }, 502);
    const locData = await locRes.json();
    locationId = locData.data?.[0]?.locationId;
    if (!locationId) return json({ error: "No Kroger store found near that zip code" }, 404);
    await supabase.from("kroger_connections").update({ kroger_location_id: locationId }).eq("user_id", userId);
  }

  const results: { term: string; matched: string | null; added: boolean; qty: number; packInfo?: string }[] = [];

  // Normalize items: accept either plain strings (old shape) or {term, qty, isCount, unit}.
  const normalizedItems: { term: string; qty: number; isCount: boolean; unit: string | null }[] = items.map((it: unknown) =>
    typeof it === "string"
      ? { term: it, qty: 1, isCount: false, unit: null }
      : { term: (it as any).term, qty: (it as any).qty || 1, isCount: !!(it as any).isCount, unit: (it as any).unit || null }
  );

  // "2 dozen", "18 ct", "12 count" etc. -> how many individual units are in
  // one pack, so we can work out how many packs to actually add to cart.
  function packUnitsFromSize(size: string | undefined): number | null {
    if (!size) return null;
    const s = size.toLowerCase();
    const dozenMatch = s.match(/(\d+(\.\d+)?)\s*dozen/);
    if (dozenMatch) return parseFloat(dozenMatch[1]) * 12;
    if (s.includes("dozen")) return 12;
    const ctMatch = s.match(/(\d+(\.\d+)?)\s*(ct|count|each|ea)\b/);
    if (ctMatch) return parseFloat(ctMatch[1]);
    return null;
  }

  // "8 oz" ingredient against a "15 oz" can should add 1 can, not 8 —
  // parse how many ounces are actually in one pack of the matched product
  // so oz/lb amounts get converted into a pack count instead of being used
  // as one directly. Only handles weight ounces (canned/packaged goods),
  // not fluid ounces of liquid, which is close enough for grocery-shelf sizes.
  function packOzFromSize(size: string | undefined): number | null {
    if (!size) return null;
    const s = size.toLowerCase();
    const ozMatch = s.match(/(\d+(\.\d+)?)\s*(oz|ounce|ounces)\b/);
    if (ozMatch) return parseFloat(ozMatch[1]);
    const lbMatch = s.match(/(\d+(\.\d+)?)\s*(lb|lbs|pound|pounds)\b/);
    if (lbMatch) return parseFloat(lbMatch[1]) * 16;
    return null;
  }

  // Units that are themselves a pack count (a "can" or "bag" already IS the
  // thing you buy) vs. weight units that need converting against the real
  // product size vs. small culinary measures (cup, tsp, tbsp, clove...)
  // where doubling the pack count would be wrong — those just need 1 pack.
  const PACK_COUNT_UNITS = new Set(["can", "cans", "jar", "jars", "bag", "bags", "pkg", "packet", "packets"]);
  const WEIGHT_UNITS = new Set(["oz", "lb"]);

  for (const { term, qty, isCount, unit } of normalizedItems) {
    // Pull a handful of candidates rather than just the top hit, so we can
    // pick the cheapest one instead of whatever Kroger's default ranking
    // (often a pricier private-label organic item) happens to put first.
    const searchRes = await fetch(
      `https://api.kroger.com/v1/products?filter.term=${encodeURIComponent(term)}&filter.locationId=${locationId}&filter.limit=8`,
      { headers: { Authorization: `Bearer ${appToken}` } }
    );
    if (!searchRes.ok) {
      results.push({ term, matched: null, added: false, qty, reason: "search_failed" });
      continue;
    }
    const searchData = await searchRes.json();
    let candidates = (searchData.data || []).filter((p: any) => p.items?.[0]?.price?.regular != null);
    if (!candidates.length) {
      results.push({ term, matched: null, added: false, qty, reason: "no_match" });
      continue;
    }

    // Kroger's search is a loose keyword match, not an exact phrase match —
    // "baby potatoes" can pull back baby food alongside actual potatoes,
    // because "baby" alone is a strong hit in their baby-products catalog.
    // Sorting by cheapest price then picks whatever's cheapest of the whole
    // pile, unrelated products included. Require the core noun (the last
    // word of the search term, roughly the actual food item) to show up in
    // the product's own description before it's eligible at all.
    const coreNoun = term.trim().split(/\s+/).pop()!.toLowerCase().replace(/s$/, "");
    if (coreNoun.length > 2) {
      const relevant = candidates.filter((p: any) => p.description.toLowerCase().includes(coreNoun));
      if (relevant.length) candidates = relevant;
    }

    const nonOrganic = candidates.filter((p: any) => !/organic/i.test(p.description));
    let pool = nonOrganic.length ? nonOrganic : candidates;

    // Milk is conventionally bought as a half gallon or a full gallon
    // regardless of how little a recipe actually uses — nobody buys a
    // single-serving carton for a "splash" in a meatloaf. A splash, or an
    // amount under a cup (tsp/tbsp/oz), calls for a half gallon; a cup or
    // more calls for a full gallon.
    if (/\bmilk\b/i.test(term)) {
      const isHalfGallon = (size: string) => {
        const s = size.toLowerCase();
        return s.includes("half gallon") || /\b0\.5\s*gal\b/.test(s) || /\b64\s*fl/.test(s);
      };
      const isGallon = (size: string) => {
        const s = size.toLowerCase();
        return (/\bgal\b/.test(s) && !s.includes("half")) || /\b128\s*fl/.test(s);
      };
      const wantsGallon = unit === "cup";
      const match = pool.filter((p: any) => {
        const size = (p.items?.[0]?.size || "").toLowerCase();
        return wantsGallon ? isGallon(size) : isHalfGallon(size);
      });
      const fallback = wantsGallon
        ? pool.filter((p: any) => isHalfGallon((p.items?.[0]?.size || "").toLowerCase()))
        : pool.filter((p: any) => isGallon((p.items?.[0]?.size || "").toLowerCase()));
      if (match.length) pool = match;
      else if (fallback.length) pool = fallback;
    }

    pool.sort((a: any, b: any) => a.items[0].price.regular - b.items[0].price.regular);
    const product = pool[0];
    const packSize: string | undefined = product.items?.[0]?.size;

    // Figure out how many packs of the matched product actually cover the
    // amount needed, instead of treating the ingredient's number as a pack
    // count directly.
    let cartQty = 1;
    if (isCount) {
      // Counted items (eggs, buns…) — e.g. 14 eggs against a "1 dozen"
      // carton means 2 cartons, not 1.
      const unitsPerPack = packUnitsFromSize(packSize);
      cartQty = unitsPerPack ? Math.ceil(qty / unitsPerPack) : 1;
    } else if (unit && WEIGHT_UNITS.has(unit)) {
      // Weight amounts (8 oz, 1 lb…) — e.g. 8 oz of tomato sauce against a
      // "15 oz" can means 1 can, not 8. Convert lb to oz for comparison.
      const neededOz = unit === "lb" ? qty * 16 : qty;
      const packOz = packOzFromSize(packSize);
      cartQty = packOz ? Math.max(1, Math.ceil(neededOz / packOz)) : 1;
    } else if (unit && PACK_COUNT_UNITS.has(unit)) {
      // "2 cans diced tomatoes" already means 2 packages, literally.
      cartQty = Math.max(1, Math.round(qty));
    }
    // Anything else (cup, tsp, tbsp, clove, slice…) is a small culinary
    // measure, not a retail pack size — one package covers it, so cartQty
    // stays at 1 rather than multiplying by the recipe's number.

    const addRes = await fetch("https://api.kroger.com/v1/cart/add", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ items: [{ upc: product.productId, quantity: cartQty }] }),
    });

    results.push({
      term,
      matched: product.description,
      added: addRes.ok,
      qty: cartQty,
      packInfo: packSize,
      reason: addRes.ok ? undefined : "unavailable_at_store",
    });
  }

  return json({ results, storeLocationId: locationId });
});
