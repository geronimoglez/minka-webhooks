// Endpoint público: postulación a "Íconos de la Belleza · Carreras de Éxito IV" (cliente Juanelo).
//
//   GET  /postulacion       → pinta la forma
//   POST /postulacion       → valida, guarda el lead en el Odoo DE JUANELO, y 303 a la pantalla
//                             de gracias (patrón POST/Redirect/GET: recargar no reenvía la forma)
//
// La landing es 0-JS a propósito (la mayoría del tráfico llega del navegador dentro de WhatsApp),
// así que esto es una forma nativa: el POST es una NAVEGACIÓN, no un fetch. Por eso no hay CORS
// que configurar ni preflight que pagar. Se expone same-origin desde carrerasdeexito.com con un
// rewrite de esta ruta y sólo de ésta.
//
// EL ORDEN IMPORTA: primero se guarda el lead, DESPUÉS se ofrece el apartado. Si la persona
// abandona el pago, su postulación ya está en el CRM y se le puede dar seguimiento. Cobrar antes
// de capturar convertiría cada duda en un lead perdido.

const crm = require("../lib/crm");
const sign = require("../lib/sign");
const { config } = require("../lib/evento");
const { formPage, FIELDS } = require("../lib/postulacion_html");

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";

const clip = (s, n) => String(s ?? "").slice(0, n).trim();

// Rate limit en memoria del contenedor. No es una defensa fuerte (Vercel puede levantar varias
// instancias), pero corta el caso real: alguien recargando el envío o un bot simple.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 5000) hits.clear(); // techo de memoria del contenedor
  const rec = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  rec.push(now);
  hits.set(ip, rec);
  return rec.length > 6;
}

// Igual que en onboarding.js: allowlist de tokens diagnósticos que genera NUESTRO código. Cualquier
// string inesperado colapsa a "crm-error" para que una regresión futura no pueda filtrar PII.
const SAFE_DETAIL = [
  /^odoo-rejected:[A-Za-z0-9_]+$/, /^odoo-http-\d{3}$/, /^odoo-auth-failed$/,
  /^odoo-rpc-failed$/, /^odoo-error$/, /^crm-bad-tenant$/,
];
const safeDetail = (d) => {
  const s = String(d ?? "");
  if (!s) return undefined;
  if (/^CRM sin configurar/.test(s)) return "crm-unconfigured";
  return SAFE_DETAIL.some((re) => re.test(s)) ? s : "crm-error";
};

/* ───────────────────────────────── Validación ───────────────────────────────── */

// El email es OBLIGATORIO: el dedup de lib/crm.js es email-only. Sin email cada reenvío crearía un
// contacto nuevo y el CRM se llenaría de duplicados de la misma persona.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Al menos 8 dígitos: filtra el "no tengo" y los dedazos, sin exigir un formato que en México se
// escribe de seis maneras distintas.
const phoneDigits = (s) => String(s).replace(/\D/g, "").length;

function validate(v) {
  const e = {};
  for (const f of FIELDS) {
    if (f.required && !v[f.name]) e[f.name] = "Este dato nos hace falta.";
  }
  if (v.email && !EMAIL_RE.test(v.email)) e.email = "Revisa el correo — parece que falta algo.";
  if (v.whatsapp && phoneDigits(v.whatsapp) < 8) e.whatsapp = "Escribe tu número con lada, por favor.";
  if (v.trayectoria && v.trayectoria.length < 30) {
    e.trayectoria = "Cuéntanos un poco más — con dos o tres líneas nos basta.";
  }
  if (!v.privacidad) e.privacidad = "Necesitamos tu consentimiento para poder contactarte.";
  return e;
}

function readValues(b) {
  const v = {};
  for (const f of FIELDS) v[f.name] = clip(b[f.name], f.max || 200);
  v.email = v.email.toLowerCase();
  v.tequila = b.tequila === "si";
  v.privacidad = b.privacidad === "si";
  return v;
}

/* ────────────────────────────────── Handler ────────────────────────────────── */

module.exports = async (req, res) => {
  const cfg = config();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");

  if (req.method === "GET" || req.method === "HEAD") {
    // La forma vacía no lleva datos de nadie → se puede cachear en el edge. Así el 99% de las
    // visitas no paga el arranque en frío de la función.
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=86400");
    return res.status(200).send(formPage({ values: {}, errors: {}, cfg }));
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).send("Método no permitido");
  }

  // Cualquier respuesta a un POST lleva datos de la persona → nunca se cachea.
  res.setHeader("Cache-Control", "no-store");

  try {
    const b = req.body || {};
    if (b.website_hp) {
      // Honeypot: los bots llenan todo. Se responde como si hubiera funcionado, sin escribir nada.
      res.setHeader("Location", "/postulacion/gracias");
      return res.status(303).end();
    }

    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
    if (rateLimited(ip)) {
      return res.status(429).send(formPage({
        values: readValues(b), cfg,
        errors: { nombre: "Recibimos varios envíos desde aquí. Espera un momento y vuelve a intentar." },
      }));
    }

    const v = readValues(b);
    const errors = validate(v);
    if (Object.keys(errors).length) {
      // Re-render con TODO lo que ya había escrito. Ni un redirect (perdería los valores o los
      // pondría en la URL) ni un mensaje genérico.
      return res.status(422).send(formPage({ values: v, errors, cfg }));
    }

    const nota = [
      "POSTULACIÓN — Íconos de la Belleza · Carreras de Éxito IV",
      "",
      `Ciudad: ${v.ciudad}`,
      `Negocio/marca: ${v.negocio || "—"}`,
      `Años de trayectoria: ${v.anios || "—"}`,
      `Redes: ${v.redes || "—"}`,
      `Portafolio: ${v.portafolio || "—"}`,
      `Extra del domingo (Tequila): ${v.tequila ? "SÍ le interesa" : "no"}`,
      "",
      "TRAYECTORIA (en sus palabras):",
      v.trayectoria,
      "",
      `Aviso de privacidad aceptado: sí · ${new Date().toISOString()}`,
    ].join("\n");

    const tags = ["postulacion", "iconos-belleza-iv", "carrerasdeexito.com"];
    if (v.tequila) tags.push("extra-tequila");

    const crmRes = await crm.pushLead(
      { nombre: v.nombre, email: v.email, whatsapp: v.whatsapp, negocio: v.negocio,
        source: "postulacion-web" },
      { tags, note: nota, tenant: cfg.tenant });

    // Aviso interno SIEMPRE, haya o no CRM: es la red de seguridad que hace que ninguna
    // postulación se pierda aunque Odoo esté dormido.
    if (TG_TOKEN && TG_CHAT) {
      const text = [
        "✨ POSTULACIÓN — Íconos de la Belleza IV",
        `👤 ${v.nombre}${v.negocio ? ` · ${v.negocio}` : ""}`,
        `📱 ${v.whatsapp} · ${v.email}`,
        `📍 ${v.ciudad}${v.anios ? ` · ${v.anios} de trayectoria` : ""}`,
        v.redes ? `📸 ${v.redes}` : "",
        v.tequila ? "🥃 Le interesa el extra del domingo" : "",
        "",
        v.trayectoria.slice(0, 700),
        "",
        crmRes.ok ? `✅ CRM (${cfg.tenant}) lead #${crmRes.id}`
                  : `⚠️ CRM FALLÓ (${safeDetail(crmRes.detail)}) — capturar a mano`,
      ].filter(Boolean).join("\n");
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TG_CHAT, text }),
      }).catch(() => {});
    }

    // Sin lead no hay a qué ligar el pago ni los documentos. La pantalla de gracias lo sabe y
    // degrada a WhatsApp en vez de fingir que todo salió bien.
    let token = "";
    if (crmRes.ok && crmRes.id) {
      try {
        token = sign.issue(crmRes.id, { secret: process.env.POSTULACION_TOKEN_SECRET });
      } catch { token = ""; }
    }

    res.setHeader("Location", token ? `/postulacion/gracias?t=${encodeURIComponent(token)}`
                                    : "/postulacion/gracias");
    return res.status(303).end();
  } catch (e) {
    return res.status(500).send(formPage({
      values: {}, cfg,
      errors: { nombre: "Algo falló de nuestro lado. Vuelve a intentar o escríbenos por WhatsApp." },
    }));
  }
};

// Exportados sólo para los tests.
module.exports.__validate = validate;
module.exports.__readValues = readValues;
module.exports.__safeDetail = safeDetail;
