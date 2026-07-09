// Public endpoint: estado del cliente — minkadigital.com/portal
// Fase 3 v1: el cliente consulta el estado de su asistente con email + últimos 4 dígitos de su
// WhatsApp (verificación ligera; no hay password todavía). Devuelve SOLO estado derivado de tags
// de GHL — nunca notas internas ni datos de otros contactos. Dashboard completo = fase posterior.

const crm = require("../lib/crm"); // adaptador Odoo/GHL/none (decisión 2026-07-08: Odoo primero)

const ALLOWED_ORIGINS = [
  "https://minkadigital.com",
  "https://www.minkadigital.com",
  "http://localhost:3000",
];

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < 600_000);
  rec.push(now);
  hits.set(ip, rec);
  return rec.length > 10; // 10 consultas / 10 min / IP (anti-enumeración)
}

const clip = (s, n) => String(s ?? "").slice(0, n).trim();

function estadoFromTags(tags) {
  const t = (tags || []).map((x) => String(x).toLowerCase());
  const plan = (t.find((x) => x.startsWith("onboarding-")) || "").replace("onboarding-", "") || null;
  if (t.includes("bot-activo")) {
    return { fase: "activo", titulo: "Tu asistente está ACTIVO 🎉", plan,
      pasos: [
        { done: true, txt: "Diagnóstico" },
        { done: true, txt: "Paquete de conocimiento recibido" },
        { done: true, txt: "Asistente configurado y entrenado" },
        { done: true, txt: "En operación — atendiendo a tus clientes" },
      ] };
  }
  if (t.some((x) => x.startsWith("onboarding"))) {
    return { fase: "activando", titulo: "Estamos armando tu asistente 🔧", plan,
      pasos: [
        { done: true, txt: "Diagnóstico" },
        { done: true, txt: "Paquete de conocimiento recibido" },
        { done: false, txt: "Configuración y entrenamiento (24-48 h)" },
        { done: false, txt: "Videollamada de bienvenida + entrega" },
      ] };
  }
  if (t.includes("diagnostico-p0")) {
    return { fase: "diagnosticado", titulo: "Tienes tu diagnóstico — el siguiente paso es activar", plan,
      pasos: [
        { done: true, txt: "Diagnóstico realizado" },
        { done: false, txt: "Activa tu plan en minkadigital.com/activar" },
      ] };
  }
  return { fase: "lead", titulo: "Te tenemos registrado — empieza con tu diagnóstico gratis", plan,
    pasos: [{ done: false, txt: "Haz tu diagnóstico en minkadigital.com/diagnostico" }] };
}

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
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "?";
    if (rateLimited(ip)) return res.status(429).json({ error: "Demasiadas consultas — espera unos minutos." });

    const email = clip(req.body?.email, 120).toLowerCase();
    const tel4 = clip(req.body?.tel4, 4);
    if (!email.includes("@") || tel4.length !== 4) {
      return res.status(400).json({ error: "Necesito tu correo y los últimos 4 dígitos de tu WhatsApp." });
    }

    const c = await crm.findByEmail(email);
    // Respuesta uniforme si no existe o no verifica (anti-enumeración de correos)
    const fail = { error: "No encontré ese registro. Verifica correo y últimos 4 dígitos, o haz tu diagnóstico gratis." };
    if (c.unavailable) return res.status(503).json({ error: "El portal está en mantenimiento — escríbenos por WhatsApp." });
    if (!c.found) return res.status(404).json(fail);
    const phone = String(c.phone || "").replace(/\D/g, "");
    if (!phone.endsWith(tel4)) return res.status(404).json(fail);

    const estado = estadoFromTags(c.tags);
    return res.status(200).json({ ok: true, nombre: c.nombre || "", negocio: c.negocio || "", ...estado });
  } catch (e) {
    return res.status(500).json({ error: "Error consultando tu estado." });
  }
};
