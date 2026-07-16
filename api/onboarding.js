// Public endpoint: onboarding de activación de plan — minkadigital.com/activar
// Fase 2 de la escalera: el prospecto (normalmente post-diagnóstico) pide activar su asistente.
// Captura el "paquete de conocimiento" del negocio → lead/opportunity en Odoo (tag onboarding-<plan>)
// → ping Telegram con TODO lo necesario para correr el pipeline demo_bot/tenant sin buscar nada.
//
// El fulfillment de v1 es semi-automático a propósito: Gerónimo recibe el ping, corre
// scripts/demo_bot.py con los datos ya capturados, y agenda la videollamada de bienvenida (P1).
// La automatización total del provisioning es fase posterior (requiere pago en línea + BotFather).

const crm = require("../lib/crm");
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";

const ALLOWED_ORIGINS = [
  "https://minkadigital.com",
  "https://www.minkadigital.com",
  "http://localhost:3000",
];

const PLANES = new Set(["respuesta-ia", "funnel-esencial", "sistema-crecimiento"]);

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  rec.push(now);
  hits.set(ip, rec);
  return rec.length > 4;
}

const clip = (s, n) => String(s ?? "").slice(0, n).trim();

// Allowlist de `detail` para la respuesta PÚBLICA. crm.js ya sanea en origen (no propaga el mensaje
// crudo de Odoo, que puede eco-ar PII — ship-review 2026-07-13), pero ésta es la superficie expuesta a
// internet: defensa en profundidad. Sólo dejamos pasar tokens diagnósticos que genera NUESTRO código;
// cualquier string inesperado colapsa a "crm-error" para que una regresión futura no pueda filtrar PII.
const SAFE_DETAIL = [
  /^odoo-rejected:[A-Za-z0-9_]+$/, // clase de excepción de Odoo, sin PII (ver crm.js)
  /^odoo-http-\d{3}$/,             // 5xx transitorio del wake
  /^odoo-auth-failed$/,
  /^odoo-rpc-failed$/,
  /^odoo-error$/,
];
const safeDetail = (d) => {
  const s = String(d ?? "");
  if (!s) return undefined;
  if (/^CRM sin configurar/.test(s)) return "crm-unconfigured"; // driver "none" (no sensible)
  return SAFE_DETAIL.some((re) => re.test(s)) ? s : "crm-error";
};


module.exports = async (req, res) => {
  const origin = req.headers.origin || "";
  const corsOk = ALLOWED_ORIGINS.includes(origin) || /https:\/\/.*\.vercel\.app$/.test(origin);
  if (corsOk) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  try {
    const b = req.body || {};
    if (b.website_hp) return res.status(200).json({ ok: true }); // honeypot

    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "?";
    if (rateLimited(ip)) return res.status(429).json({ error: "Demasiadas solicitudes — intenta más tarde." });

    const p = {
      plan: clip(b.plan, 40),
      nombre: clip(b.nombre, 80),
      email: clip(b.email, 120).toLowerCase(),
      whatsapp: clip(b.whatsapp, 24),
      negocio: clip(b.negocio, 120),
      giro: clip(b.giro, 100),
      sitio: clip(b.sitio, 200),
      redes: clip(b.redes, 300),
      queVendes: clip(b.queVendes, 600),
      precios: clip(b.precios, 600),
      horarios: clip(b.horarios, 200),
      politicas: clip(b.politicas, 500),
      tono: clip(b.tono, 200),
      canalPreferido: clip(b.canalPreferido, 60),
    };
    if (!PLANES.has(p.plan)) return res.status(400).json({ error: "Plan inválido." });
    if (!p.nombre || !p.email.includes("@") || !p.negocio || !p.whatsapp) {
      return res.status(400).json({ error: "Faltan datos: nombre, email, WhatsApp y negocio." });
    }

    const note = [
      `🚀 SOLICITUD DE ACTIVACIÓN — plan: ${p.plan}`,
      "",
      "PAQUETE DE CONOCIMIENTO (para demo_bot.py / tenant):",
      `  · Negocio: ${p.negocio} (${p.giro})`,
      `  · Sitio: ${p.sitio || "—"}`,
      `  · Redes: ${p.redes || "—"}`,
      `  · Qué vende: ${p.queVendes}`,
      `  · Precios: ${p.precios || "—"}`,
      `  · Horarios: ${p.horarios || "—"}`,
      `  · Políticas: ${p.politicas || "—"}`,
      `  · Tono deseado: ${p.tono || "—"}`,
      `  · Canal preferido: ${p.canalPreferido || "—"}`,
      "",
      "SIGUIENTE PASO (Gerónimo): videollamada de bienvenida + correr pipeline demo_bot",
      `Fecha: ${new Date().toISOString()}`,
    ].join("\n");
    const crmRes = await crm.pushLead(
      { nombre: p.nombre, email: p.email, whatsapp: p.whatsapp, negocio: p.negocio, source: "activar-web" },
      { tags: ["onboarding", `onboarding-${p.plan}`, "minkadigital.com"], note });

    // Ping accionable a Telegram
    if (TG_TOKEN && TG_CHAT) {
      const cmd = `railway run python scripts/demo_bot.py --prospecto ${p.negocio.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 26)} --display "${p.negocio}"${p.sitio ? ` --sitio ${p.sitio}` : ""}`;
      const text = [
        `🚀 ACTIVACIÓN ${p.plan.toUpperCase()}`,
        `👤 ${p.nombre} · ${p.negocio} (${p.giro})`,
        `📱 ${p.whatsapp} · ${p.email}`,
        `🌐 ${p.sitio || p.redes || "sin sitio"}`,
        "",
        `▶️ Comando sugerido:`,
        cmd,
        "",
        "1) Correr pipeline · 2) Crear bot @BotFather · 3) Videollamada bienvenida",
      ].join("\n");
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT, text }),
      }).catch(() => {});
    }

    // Telemetría honesta: si el CRM falló, que se vea en la respuesta (el ping a Telegram salió
    // igual, así el lead no se pierde) — sin exponer datos sensibles.
    return res.status(200).json({ ok: true, crm: crmRes.ok ? "ok" : (crmRes.driver === "none" ? "skipped" : "failed"), driver: crmRes.driver, detail: safeDetail(crmRes.detail) });
  } catch (e) {
    return res.status(500).json({ error: "Error registrando tu solicitud." });
  }
};
