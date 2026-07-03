/**
 * Budget Passbook — AI Proxy Worker
 *
 * Sits between the app (in users' browsers) and the Anthropic API.
 * Holds YOUR Anthropic API key as a secret — users never see it or need
 * their own key. Enforces a per-device daily limit so no single user
 * can run up unlimited spend on your account.
 *
 * Deploy: see README.md in this folder.
 */

const RATE_LIMIT_PER_DAY = 20;           // free AI actions per device per day
const MAX_TOKENS_CAP = 600;              // hard ceiling regardless of what the app requests
const ALLOWED_MODELS = new Set([
  "claude-haiku-4-5-20251001",
  "claude-sonnet-5"
]);

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, env);
    }

    const deviceId = request.headers.get("x-device-id");
    if (!deviceId || deviceId.length > 100) {
      return jsonResponse({ error: "missing_device_id" }, 400, env);
    }

    // ---- Rate limiting (per device, per calendar day UTC) ----
    const today = new Date().toISOString().slice(0, 10);
    const rlKey = `rl:${deviceId}:${today}`;
    const countStr = await env.RATE_LIMIT_KV.get(rlKey);
    const count = countStr ? parseInt(countStr, 10) : 0;

    if (count >= RATE_LIMIT_PER_DAY) {
      return jsonResponse(
        { error: "rate_limited", limit: RATE_LIMIT_PER_DAY },
        429,
        env
      );
    }

    // ---- Parse and validate the request body ----
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "bad_request" }, 400, env);
    }

    if (!ALLOWED_MODELS.has(body.model)) {
      return jsonResponse({ error: "invalid_model" }, 400, env);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return jsonResponse({ error: "invalid_messages" }, 400, env);
    }

    // Cap tokens server-side so a modified client can't request huge responses
    body.max_tokens = Math.min(Number(body.max_tokens) || 300, MAX_TOKENS_CAP);

    // ---- Forward to Anthropic using YOUR secret key ----
    let anthropicRes;
    try {
      anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      return jsonResponse({ error: "upstream_network_error" }, 502, env);
    }

    // Only count successful calls against the daily limit
    if (anthropicRes.ok) {
      await env.RATE_LIMIT_KV.put(rlKey, String(count + 1), {
        expirationTtl: 60 * 60 * 26 // a little over a day, auto-cleans itself up
      });
    }

    const data = await anthropicRes.text();
    return new Response(data, {
      status: anthropicRes.status,
      headers: { ...corsHeaders(env), "content-type": "application/json" }
    });
  }
};

function corsHeaders(env) {
  return {
    // Tighten this to your actual hosted domain once deployed, e.g.
    // "https://yourusername.github.io"
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-device-id"
  };
}

function jsonResponse(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders(env), "content-type": "application/json" }
  });
}
