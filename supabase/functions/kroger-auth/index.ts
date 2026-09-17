// Handles the Kroger OAuth handshake.
//
// GET  ?action=start    -> returns { url } to redirect the browser to Kroger's consent screen
// POST { code, state }  -> exchanges the auth code for tokens, stores them for that user
//
// Called by the browser with the signed-in user's Supabase JWT in the
// Authorization header, so we know which user_id to attach the Kroger
// tokens to.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const KROGER_CLIENT_ID = Deno.env.get("KROGER_CLIENT_ID")!;
const KROGER_CLIENT_SECRET = Deno.env.get("KROGER_CLIENT_SECRET")!;
const KROGER_REDIRECT_URI = Deno.env.get("KROGER_REDIRECT_URI")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function getUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const url = new URL(req.url);

  if (req.method === "GET" && url.searchParams.get("action") === "start") {
    const userId = await getUserId(req);
    if (!userId) return json({ error: "Not signed in" }, 401);

    const authorizeUrl = new URL("https://api.kroger.com/v1/connect/oauth2/authorize");
    authorizeUrl.searchParams.set("scope", "cart.basic:write profile.compact");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", KROGER_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", KROGER_REDIRECT_URI);
    authorizeUrl.searchParams.set("state", userId);

    return json({ url: authorizeUrl.toString() });
  }

  if (req.method === "POST") {
    const { code, state } = await req.json();
    if (!code || !state) return json({ error: "Missing code or state" }, 400);

    // `state` claims to be the user_id the flow was started for — verify the
    // caller's own JWT actually belongs to that same user before trusting it,
    // so a forged `state` can't attach someone else's Kroger tokens to your account.
    const callerUserId = await getUserId(req);
    if (!callerUserId || callerUserId !== state) return json({ error: "Session mismatch" }, 401);
    const userId = callerUserId;

    const basicAuth = btoa(`${KROGER_CLIENT_ID}:${KROGER_CLIENT_SECRET}`);
    const tokenRes = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${basicAuth}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: KROGER_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      return json({ error: "Kroger token exchange failed", detail: errText }, 502);
    }

    const tokens = await tokenRes.json();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await supabase.from("kroger_connections").upsert({
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
    });

    if (error) return json({ error: "Failed to save connection", detail: error.message }, 500);

    return json({ connected: true });
  }

  return json({ error: "Not found" }, 404);
});
