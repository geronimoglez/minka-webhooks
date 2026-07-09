// Public endpoint: receives pre-calificación submissions from sedeco.minkadigital.com/pre-califica
// Upserts contact in GHL, applies tags by score, creates opportunity, pings Telegram.
//
// No signature required (public form endpoint). Rate limiting handled at Vercel infra level.

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_TOKEN = process.env.GHL_TOKEN_LOCATION || "";
const GHL_LOCATION = process.env.GHL_LOCATION_ID || "";
const PIPELINE_ID = process.env.GHL_PIPELINE_ID || "";
const STAGE_1_ID = process.env.GHL_STAGE_1_ID || "";
const STAGE_2_ID = process.env.GHL_STAGE_2_ID || "";

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";

// Custom field IDs in GHL (must match what ghl_bootstrap.py created)
const CF = {
  rubro:           "psN76W4Hsy0lD7K0oA01", // SEDECO Rubro
  score:           "blb1aXaWSASo23bqTJci", // SEDECO Score Pre-calificación
  monto:           "1Ho7jiI1iDWrPQZ3Ibzo", // SEDECO Monto Máximo MXN
  preScore:        "vg7TlSYQdKqgKDE6siAt", // Pre-calificación SEDECO Score (form scoring)
  empleadosIMSS:   "ZDcyjEi8W9A5RvepTsdg", // Empleados IMSS
  herramientas:    "XbKtDOc2TyItjUggXwc7", // Herramientas previas
  problematica:    "lAnbF84WJANbCqHrWJmF", // Problemática del negocio
  aportacion:      "7s0FGRzqZHLJKMpHC7ZC", // Aportación posible
  diagnostico:     "P7VxXsTTOCRzOKTTfs9D", // Diagnóstico ID Empresa
  canales:         "MC6Z4xLsXcsTecvSkf6A", // Canales de captación
  fuente:          "DQAVYf5KWzhfNDRuwOpy", // Fuente Origen
  // --- Paso 5 (datos formales Anexos SEDECO) ---
  rfc:             "D8WXEUrcDNivnYMllRXu", // RFC
  domicilioFiscal: "hkbASxbXyYexn2AW1Kq5", // Domicilio Fiscal
  razonSocialLegal:"ovDkRG5hrxT0iEyKiul0", // Razón Social Legal
};

const RUBRO_MAP = {
  ia:         "Asistente IA",
  asistente_ia: "Asistente IA",
  crm:        "CRM",
  erp:        "ERP",
  ecommerce:  "E-commerce",
  control:    "Control de negocio",
  control_negocio: "Control de negocio",
};

const MONTO_MAP = {
  "Asistente IA": 150000,
  "ERP": 150000,
  "CRM": 100000,
  "E-commerce": 60000,
  "Control de negocio": 60000,
};

const APORTACION_MAP = {
  si: "sí",
  no: "necesito platicarlo",
};

const JOTFORM_URL = "https://www.jotform.com/form/261325912379057";
const WHATSAPP_GROUP = "https://chat.whatsapp.com/L8cy6nIgQGuAp9oE0mkviQ";

const VERSION = "2021-07-28";

async function ghl(method, path, body) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${GHL_TOKEN}`,
      "Version": VERSION,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "MinkaPrecalifica/1.0",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { _raw: txt }; }
  return { status: r.status, data };
}

async function findContactByEmail(email) {
  const { status, data } = await ghl("GET",
    `/contacts/search/duplicate?locationId=${GHL_LOCATION}&email=${encodeURIComponent(email)}`);
  if (status === 200 && data.contact) return data.contact.id;
  return null;
}

async function findContactByPhone(phone) {
  if (!phone) return null;
  // GHL search by number (E.164)
  const q = encodeURIComponent(phone);
  const { status, data } = await ghl("GET",
    `/contacts/search/duplicate?locationId=${GHL_LOCATION}&number=${q}`);
  if (status === 200 && data.contact) return data.contact.id;
  return null;
}

async function findOpportunityForContact(contactId) {
  const { status, data } = await ghl("GET",
    `/opportunities/search?location_id=${GHL_LOCATION}&contact_id=${contactId}&pipeline_id=${PIPELINE_ID}`);
  if (status === 200 && Array.isArray(data.opportunities) && data.opportunities.length > 0) {
    return data.opportunities[0].id;
  }
  return null;
}

function buildNoteBody(p) {
  const lines = [
    "📋 Auto-llenado desde sedeco.minkadigital.com/pre-califica",
    "",
    `Score calculado: ${p.score}/100 — ${p.verdict}`,
    "",
    "Gates obligatorios:",
    `  · RFC Jalisco activo: ${p.gates?.rfc || "—"}`,
    `  · Antigüedad SAT (+2 años): ${p.gates?.antiguedad || "—"}`,
    `  · Opinión SAT positiva: ${p.gates?.opinionSat || "—"}`,
    `  · Adeudos SEDECO previos: ${p.gates?.adeudosSedeco || "—"}`,
    "",
    "Perfil:",
    `  · Tipo: ${p.profile?.tipo || "—"}`,
    `  · Tamaño: ${p.profile?.empleados || "—"}`,
    `  · Municipio: ${p.profile?.municipio || "—"} (${p.profile?.municipio === "fuera" ? "fuera AMG" : "AMG"})`,
    `  · Rubro tentativo: ${p.profile?.rubro || "—"}`,
    "",
    "Scoring criterios:",
    `  · Empleados IMSS: ${p.scoring?.imss || "—"}`,
    `  · Herramientas digitales previas: ${p.scoring?.digitales || "—"}`,
    `  · Cursos SEDECO 2025: ${p.scoring?.cursos || "—"}`,
    `  · Aportación > mínimo: ${p.scoring?.aportacion || "—"}`,
    `  · Distintivo CRECE: ${p.scoring?.crece || "—"}`,
    `  · Bonus delito patrimonial: ${p.scoring?.bonusDelito || "no"}`,
    `  · Bonus familiar desaparecido: ${p.scoring?.bonusFamiliar || "no"}`,
    "",
    `Fecha submit: ${new Date().toISOString()}`,
  ];
  return lines.join("\n");
}

function tagsFromScore(score) {
  const t = ["sedeco-2026", "pre-cal-formulario"];
  if (score >= 80) t.push("pre-cal-alto");
  else if (score >= 65) t.push("pre-cal-rango");
  else t.push("pre-cal-bajo");
  return t;
}

async function pingTelegram(payload) {
  if (!TG_TOKEN || !TG_CHAT) return null;
  const score = payload.score;
  const emoji = score >= 80 ? "🟢" : score >= 65 ? "🟡" : "🔴";
  const text = [
    `📋 *Pre-cal completada* ${emoji}`,
    `👤 ${payload.firstName || ""} ${payload.lastName || ""}`,
    payload.email ? `📧 ${payload.email}` : null,
    payload.phone ? `📱 ${payload.phone}` : null,
    payload.companyName ? `🏢 ${payload.companyName}` : null,
    `📊 Score: ${score}/100 · ${payload.verdict || ""}`,
    payload.profile?.rubro ? `🎯 Rubro tentativo: ${payload.profile.rubro}` : null,
  ].filter(Boolean).join("\n");
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "Markdown" }),
    });
  } catch (e) {
    console.error("telegram error", e);
  }
}

export default async function handler(req, res) {
  // CORS for browser POST from sedeco.minkadigital.com
  res.setHeader("Access-Control-Allow-Origin", "*"); // tighten to https://sedeco.minkadigital.com if needed
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "minka-webhooks",
      endpoint: "POST /api/precalifica",
      now: new Date().toISOString(),
      envSanity: {
        hasToken: !!GHL_TOKEN,
        hasLocation: !!GHL_LOCATION,
        hasPipeline: !!PIPELINE_ID,
        hasStage1: !!STAGE_1_ID,
        hasStage2: !!STAGE_2_ID,
      },
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!GHL_TOKEN || !GHL_LOCATION) {
    return res.status(500).json({ error: "Server misconfigured: GHL credentials missing" });
  }

  try {
    return await processSubmission(req, res);
  } catch (e) {
    console.error("[precalifica] fatal", e && e.stack || e);
    return res.status(500).json({ error: "Internal", detail: String(e && e.message || e).slice(0, 500) });
  }
}

async function processSubmission(req, res) {
  const p = req.body || {};
  const score = Number(p.score || 0);
  const email = (p.email || "").trim().toLowerCase();
  if (!email || !p.firstName) {
    return res.status(400).json({ error: "Faltan campos requeridos: firstName y email" });
  }

  const rubroLabel = RUBRO_MAP[(p.profile?.rubro || "").toLowerCase()] || "Por definir";
  const monto = MONTO_MAP[rubroLabel] || 140000;

  // 1. Upsert contact — search by email first, fallback to phone
  let contactId = await findContactByEmail(email);
  if (!contactId && p.phone) contactId = await findContactByPhone(p.phone);
  const tags = tagsFromScore(score);
  if (!p.profile?.tipo || p.profile.tipo === "pf") tags.push("persona-fisica");
  else tags.push("persona-moral");

  const customFields = [
    { id: CF.preScore, value: String(score) },
    { id: CF.rubro, value: rubroLabel },
    { id: CF.monto, value: String(monto) },
    { id: CF.fuente, value: "pre_califica_landing" },
  ];
  if (p.scoring?.aportacion) customFields.push({ id: CF.aportacion, value: APORTACION_MAP[p.scoring.aportacion] || "necesito platicarlo" });
  if (p.profile?.empleados) {
    const emp = p.profile.empleados === "micro" ? "1" : p.profile.empleados === "peq" ? "20" : p.profile.empleados === "med" ? "100" : "0";
    customFields.push({ id: CF.empleadosIMSS, value: emp });
  }
  if (p.scoring?.digitales) {
    customFields.push({ id: CF.herramientas, value: p.scoring.digitales === "si" ? "Sí usa herramientas digitales (no detallado)" : "No usa herramientas digitales aún" });
  }
  // Paso 5 opcional — datos formales Anexos
  if (p.anexos?.rfc) customFields.push({ id: CF.rfc, value: String(p.anexos.rfc).trim().toUpperCase() });
  if (p.anexos?.domicilio_fiscal) customFields.push({ id: CF.domicilioFiscal, value: String(p.anexos.domicilio_fiscal).trim() });
  if (p.anexos?.razon_social_legal) customFields.push({ id: CF.razonSocialLegal, value: String(p.anexos.razon_social_legal).trim() });
  if (p.anexos?.empleados_imss_exacto) customFields.push({ id: CF.empleadosIMSS, value: String(p.anexos.empleados_imss_exacto) });

  const contactBody = {
    locationId: GHL_LOCATION,
    firstName: p.firstName,
    lastName: p.lastName || "",
    email,
    phone: p.phone || undefined,
    companyName: p.companyName || undefined,
    tags,
    source: "pre_califica_landing",
    customFields,
  };

  let action = "created";
  if (contactId) {
    // update
    const upd = { ...contactBody };
    delete upd.locationId;
    const u = await ghl("PUT", `/contacts/${contactId}`, upd);
    if (u.status >= 400) {
      return res.status(500).json({ error: "Failed updating contact", detail: u.data });
    }
    action = "updated";
  } else {
    const c = await ghl("POST", "/contacts/", contactBody);
    if (c.status >= 400) {
      const ghlMsg = (c.data && (c.data.message || c.data.error)) || JSON.stringify(c.data).slice(0,200);
      return res.status(500).json({
        error: "Failed creating contact",
        ghl_status: c.status,
        ghl_message: ghlMsg,
        hint: ghlMsg.toLowerCase().includes("duplicat") ? "Ya hay un contacto con ese email o teléfono. El upsert no lo encontró — revisa formato de email/phone." : null,
      });
    }
    contactId = c.data?.contact?.id;
  }

  // 2. Append note with full pre-cal detail
  await ghl("POST", `/contacts/${contactId}/notes`, { body: buildNoteBody({ ...p, score }) });

  // 3. Upsert opportunity in stage 1 or 2 depending on score
  let oppId = await findOpportunityForContact(contactId);
  const targetStage = score >= 65 ? STAGE_2_ID : STAGE_1_ID;
  if (!oppId) {
    const oppBody = {
      pipelineId: PIPELINE_ID,
      locationId: GHL_LOCATION,
      name: `${p.firstName} ${p.lastName || ""} · SEDECO 2026`.trim(),
      pipelineStageId: targetStage,
      status: "open",
      contactId,
      monetaryValue: monto,
    };
    await ghl("POST", "/opportunities/", oppBody);
  } else if (targetStage) {
    await ghl("PUT", `/opportunities/${oppId}`, {
      pipelineId: PIPELINE_ID,
      pipelineStageId: targetStage,
      status: "open",
    });
  }

  // 4. Telegram ping
  await pingTelegram({ ...p, score });

  // 5. Tell the browser where to redirect next
  const next = score >= 65 ? "jotform" : "whatsapp";
  const redirect_url = score >= 65 ? JOTFORM_URL : WHATSAPP_GROUP;

  return res.status(200).json({
    ok: true,
    action,
    contact_id: contactId,
    score,
    rubro: rubroLabel,
    monto,
    next,
    redirect_url,
  });
}

