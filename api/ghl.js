// minka-webhooks · GHL webhook receiver
// Vercel serverless function: POST events from GHL workflows, fan-out to integrations.

import crypto from "node:crypto";

const SECRET = process.env.WEBHOOK_SHARED_SECRET || "";
const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
const NOTION_DB = process.env.NOTION_DATABASE_ID || "";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
const OPENCLAW_URL = process.env.OPENCLAW_WEBHOOK_URL || "";
const OPENCLAW_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";

// Bearer-style auth: header X-Webhook-Signature must equal SECRET verbatim.
// Chosen over HMAC because GHL workflows send raw POSTs without computing HMAC,
// and HMAC over a re-serialized JSON body breaks with non-ASCII chars on Vercel.
function verifySig(headerSig) {
  if (!SECRET) return true; // no secret configured = open
  if (!headerSig) return false;
  try {
    const a = Buffer.from(String(headerSig));
    const b = Buffer.from(SECRET);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function logToNotion(payload) {
  if (!NOTION_TOKEN || !NOTION_DB) return { skipped: "notion" };
  const body = {
    parent: { database_id: NOTION_DB },
    properties: {
      "Event": { title: [{ text: { content: String(payload.event || "unknown") } }] },
      "Contact": { rich_text: [{ text: { content: String(payload.contact_name || "") } }] },
      "Email": { email: payload.email || null },
      "Stage": { rich_text: [{ text: { content: String(payload.stage_name || "") } }] },
      "Payload": { rich_text: [{ text: { content: JSON.stringify(payload).slice(0, 1900) } }] },
    },
  };
  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { notion: r.status };
}

async function notifyTelegram(payload) {
  if (!TG_TOKEN || !TG_CHAT) return { skipped: "telegram" };
  const text = [
    `🔔 *GHL · ${payload.event || "evento"}*`,
    payload.contact_name ? `👤 ${payload.contact_name}` : null,
    payload.stage_name ? `📊 ${payload.stage_name}` : null,
    payload.rubro ? `🎯 Rubro: ${payload.rubro}` : null,
    payload.monto ? `💰 $${payload.monto}` : null,
  ].filter(Boolean).join("\n");
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "Markdown" }),
  });
  return { telegram: r.status };
}

async function forwardToOpenclaw(payload) {
  if (!OPENCLAW_URL) return { skipped: "openclaw" };
  const r = await fetch(OPENCLAW_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(OPENCLAW_TOKEN ? { "Authorization": `Bearer ${OPENCLAW_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  return { openclaw: r.status };
}

export default async function handler(req, res) {
  // Health check
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "minka-webhooks",
      endpoints: ["POST /api/ghl"],
      now: new Date().toISOString(),
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Vercel parses JSON automatically when content-type matches
  const payload = req.body || {};
  // Accept secret via custom header (Custom Webhook) OR query string (Standard Webhook)
  const sig = req.headers["x-webhook-signature"]
    || req.headers["x-ghl-signature"]
    || req.query?.secret;

  if (!verifySig(sig)) {
    console.warn("[ghl-webhook] invalid or missing signature");
    return res.status(401).json({ error: "invalid signature" });
  }

  console.log("[ghl-webhook] received:", JSON.stringify(payload).slice(0, 500));

  // Normalize event: from body (custom webhook) or from query (standard webhook can include ?event=stage_changed)
  // Normalize contact fields too in case GHL standard webhook sends fields flat (first_name, last_name, etc.)
  const flatName = [payload.first_name, payload.last_name].filter(Boolean).join(" ").trim();
  if (!payload.contact_name && flatName) payload.contact_name = flatName;
  if (!payload.contact_id && payload.id) payload.contact_id = payload.id;

  // Fan-out
  const fanout = {};
  const event = payload.event || payload.event_type || req.query?.event || "unknown";

  // Always log
  Object.assign(fanout, await logToNotion(payload));

  // Telegram for high-signal events
  if ([
    "stage_changed",
    "deal_won",
    "deal_lost",
    "implementacion_arranca",
    "docs_sat_listos",
    "prospecto_nuevo",   // new contact entered the SEDECO pipeline
    "form_completed",    // prospect filled Cuestionario Minka SEDECO
  ].includes(event)) {
    Object.assign(fanout, await notifyTelegram(payload));
  }

  // openclaw only when implementation kicks off
  if (event === "implementacion_arranca") {
    Object.assign(fanout, await forwardToOpenclaw(payload));
  }

  return res.status(200).json({ ok: true, received: event, fanout });
}
