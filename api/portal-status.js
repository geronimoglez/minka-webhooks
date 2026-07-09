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

// Deriva estado + pasos HONESTOS (el diagnóstico solo se marca si de verdad se hizo) + un CTA
// concreto de "próximo paso" para que el cliente nunca quede sin saber qué sigue.
function estadoFromTags(tags) {
  const t = (tags || []).map((x) => String(x).toLowerCase());
  const plan = (t.find((x) => x.startsWith("onboarding-")) || "").replace("onboarding-", "") || null;
  const hizoDiag = t.includes("diagnostico-p0");

  if (t.includes("bot-activo")) {
    return { fase: "activo", titulo: "Tu asistente está ACTIVO 🎉", plan,
      pasos: [
        { done: true, txt: "Solicitud recibida", desc: "Registramos tu negocio y tu plan." },
        { done: true, txt: "Paquete de conocimiento", desc: "Tu asistente aprendió tu negocio." },
        { done: true, txt: "Configurado y entrenado", desc: "Listo con el tono y la info de tu marca." },
        { done: true, txt: "En operación", desc: "Atendiendo a tus clientes 24/7." },
      ],
      cta: { titulo: "¿Quieres mejorar a tu asistente?",
             desc: "Envíanos más información de tu negocio (promociones, nuevos productos, políticas) y lo actualizamos.",
             accionTxt: "Mejorar mi asistente", accion: `activar${plan ? `?plan=${plan}` : ""}` } };
  }

  if (t.some((x) => x.startsWith("onboarding"))) {
    return { fase: "activando", titulo: "Estamos armando tu asistente 🔧", plan,
      pasos: [
        { done: true, txt: "Solicitud recibida", desc: "Tenemos tu plan y tus datos de contacto." },
        { done: true, txt: "Paquete de conocimiento recibido", desc: "Ya tenemos la info que nos diste de tu negocio." },
        { done: false, txt: "Configuración y entrenamiento (24-48 h)", desc: "Estamos construyendo y entrenando tu asistente con tu información." },
        { done: false, txt: "Videollamada de bienvenida + entrega", desc: "Te contactamos por WhatsApp para agendarla y entregarte tu bot funcionando." },
      ],
      cta: { titulo: "Mientras lo construimos, ayúdanos a que quede perfecto",
             desc: "Entre más sepa tu asistente (precios, horarios, promociones, preguntas típicas), mejor atiende. Agrega o completa la info de tu negocio cuando quieras.",
             accionTxt: "Completar el conocimiento de mi negocio", accion: `activar${plan ? `?plan=${plan}` : ""}` } };
  }

  if (hizoDiag) {
    return { fase: "diagnosticado", titulo: "Tienes tu diagnóstico listo — el siguiente paso es activar", plan,
      pasos: [
        { done: true, txt: "Diagnóstico realizado", desc: "Identificamos dónde automatizar tu negocio." },
        { done: false, txt: "Activa tu asistente", desc: "Elige tu plan y en 24-48 h lo tienes funcionando." },
      ],
      cta: { titulo: "Activa tu asistente",
             desc: "Ya sabemos qué automatizar en tu negocio. El siguiente paso es ponerlo a trabajar.",
             accionTxt: "Activar mi asistente", accion: "activar" } };
  }

  return { fase: "lead", titulo: "Te tenemos registrado 👋", plan,
    pasos: [{ done: false, txt: "Haz tu diagnóstico gratis", desc: "3 minutos para saber qué automatizar primero en tu negocio." }],
    cta: { titulo: "Empieza con tu diagnóstico gratis",
           desc: "En 3 minutos te decimos dónde se te está yendo el dinero y qué automatizar primero.",
           accionTxt: "Hacer mi diagnóstico gratis", accion: "diagnostico" } };
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
