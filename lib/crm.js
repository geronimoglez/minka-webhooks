// lib/crm.js — Adaptador CRM de Minka (decisión Gerónimo 2026-07-08: Odoo primero, GHL guardado).
//
// Un solo contrato para todos los endpoints; el backend real se elige por env:
//   CRM_DRIVER = "odoo" | "ghl" | "none"   (default: auto → odoo si hay ODOO_URL, ghl si hay
//                                            GHL_TOKEN_LOCATION, si no "none")
// Driver "none" = degradación honesta: los endpoints siguen funcionando (el lead viaja completo
// por Telegram) y responden crm:"skipped". Nada se rompe si el CRM está caído o sin configurar.
//
// Odoo: API externa estándar JSON-RPC (/jsonrpc, service object.execute_kw) — funciona igual en
// Odoo Online, Odoo.sh y Community self-hosted. Modelos: res.partner (contacto) + crm.lead
// (oportunidad) + chatter (message_post) para las notas de diagnóstico/onboarding.
//
// Contrato:
//   pushLead(lead, {tags, note})  → { ok, driver, id?, detail? }
//     lead = { nombre, email, whatsapp?, negocio?, source? }
//   findByEmail(email)            → { found, nombre?, negocio?, phone?, tags: string[] } | { found:false }

const ODOO_URL = (process.env.ODOO_URL || "").replace(/\/+$/, "");
const ODOO_DB = process.env.ODOO_DB || "";
const ODOO_USER = process.env.ODOO_USER || "";
const ODOO_API_KEY = process.env.ODOO_API_KEY || "";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_TOKEN = process.env.GHL_TOKEN_LOCATION || "";
const GHL_LOCATION = process.env.GHL_LOCATION_ID || "";
const GHL_VERSION = "2021-07-28";

function driver() {
  const d = (process.env.CRM_DRIVER || "").toLowerCase();
  if (d) return d;
  if (ODOO_URL && ODOO_DB && ODOO_API_KEY) return "odoo";
  if (GHL_TOKEN && GHL_LOCATION) return "ghl";
  return "none";
}

/* ----------------------------- ODOO (JSON-RPC) ----------------------------- */

let _uid = null; // cache por instancia serverless
const ODOO_TIMEOUT_MS = 10_000; // igual que callLLM: una Odoo colgada no debe colgar la función serverless
// Wake-retry para el cold-start de Railway (App Sleep): la 1ª petición tras el sueño tarda ~5-10 s en
// despertar el contenedor. Se aplica SOLO al authenticate (idempotente, ver odooUid) → despierta el
// backend antes de cualquier create/write; los create/write van con retries=0 (single-shot con
// timeout) para no duplicar un registro cuya respuesta se perdió.
//
// CLAVE (ship-review 2026-07-13): el wake está ACOTADO por un presupuesto TOTAL (ODOO_WAKE_MAX_MS),
// no por un nº fijo de intentos, para que NUNCA exceda el maxDuration del endpoint más corto
// (portal-status 10s, onboarding 15s). No se puede despertar un backend de 5-10s dentro de esos
// límites; el objetivo NO es garantizar el wake sino cubrir hipos transitorios cortos sin reventar el
// lambda. Si no despierta dentro del presupuesto, degrada limpio (Telegram/503) — la estrategia real
// es mantener Odoo despierto (este retry es sólo un seguro).
const _envNum = (name, def, lo, hi) => {          // parseo robusto: NaN/fuera-de-rango → default clampeado
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
};
const ODOO_WAKE_RETRIES = _envNum("ODOO_WAKE_RETRIES", 2, 0, 5);
const ODOO_WAKE_BACKOFF_MS = _envNum("ODOO_WAKE_BACKOFF_MS", 1500, 0, 10_000);
const ODOO_WAKE_MAX_MS = _envNum("ODOO_WAKE_MAX_MS", 6000, 0, 55_000); // presupuesto total del wake
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function odooRpc(service, method, args, { retries = 0 } = {}) {
  const body = JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(),
    params: { service, method, args } });
  // El presupuesto total sólo aplica al wake (retries>0); las llamadas normales usan el timeout de siempre.
  const deadline = retries > 0 ? Date.now() + ODOO_WAKE_MAX_MS : Infinity;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline - Date.now();
    if (attempt > 0 && remaining <= 0) break;            // presupuesto del wake agotado → degradar limpio
    const perAttempt = Math.min(ODOO_TIMEOUT_MS, remaining); // el intento no puede exceder lo que queda
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perAttempt);
    let data;
    try {
      const r = await fetch(`${ODOO_URL}/jsonrpc`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body,
      });
      // 5xx durante el wake = transitorio (proxy de Railway antes de que Odoo levante) → reintentable.
      if (r.status >= 500) throw new Error(`odoo-http-${r.status}`);
      data = await r.json(); // parse DENTRO del try → un cuerpo no-JSON durante el wake también reintenta
    } catch (e) {
      // abort (timeout) / error de red / 5xx / cuerpo no-JSON = backend despertando → reintentar si
      // quedan intentos Y presupuesto para (backoff + al menos otro intento mínimo).
      clearTimeout(timer);
      lastErr = e;
      const backoff = ODOO_WAKE_BACKOFF_MS * (attempt + 1);
      if (attempt < retries && Date.now() + backoff < deadline) { await _sleep(backoff); continue; }
      throw e;
    }
    clearTimeout(timer);
    // error de negocio de Odoo (auth, validación) = real → NO reintentar (fuera del try de reintento)
    if (data.error) throw new Error(data.error?.data?.message || data.error.message || "odoo-error");
    return data.result;
  }
  throw lastErr || new Error("odoo-rpc-failed");
}

async function odooUid() {
  if (_uid) return _uid;
  // El authenticate es el 1er round-trip de todo el flujo → aquí pagamos y absorbemos el cold-start.
  _uid = await odooRpc("common", "authenticate", [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}],
    { retries: ODOO_WAKE_RETRIES });
  if (!_uid) throw new Error("odoo-auth-failed");
  return _uid;
}

async function odooExec(model, method, args, kwargs = {}) {
  const uid = await odooUid();
  try {
    return await odooRpc("object", "execute_kw", [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]);
  } catch (e) {
    // Auto-sanación: si el contenedor serverless sigue caliente pero Odoo volvió a dormir, _uid cacheado
    // apuntaría a una sesión muerta y todas las llamadas fallarían sin recuperarse. Invalidarlo fuerza
    // un re-authenticate CON wake-retry en el próximo push (no reintentamos ESTE create/write → sin dupes).
    _uid = null;
    throw e;
  }
}

async function odooTagIds(names) {
  const ids = [];
  for (const name of names) {
    const found = await odooExec("crm.tag", "search", [[["name", "=", name]]], { limit: 1 });
    ids.push(found.length ? found[0] : await odooExec("crm.tag", "create", [{ name }]));
  }
  return ids;
}

// Etapa del pipeline de la escalera Minka según los tags del lead (cache en module-scope, que
// persiste entre invocaciones "calientes" de la función serverless — igual que _uid).
const _stageCache = {};
async function odooStageId(name) {
  if (_stageCache[name] !== undefined) return _stageCache[name];
  const found = await odooExec("crm.stage", "search", [[["name", "=", name]]], { limit: 1 });
  _stageCache[name] = found.length ? found[0] : null;
  return _stageCache[name];
}
function stageNameForTags(tags) {
  const t = (tags || []).map((x) => String(x).toLowerCase());
  if (t.some((x) => x.startsWith("onboarding"))) return "Activacion solicitada";
  if (t.includes("diagnostico-p0")) return "Diagnosticado";
  return "Lead nuevo";
}

async function odooPushLead(lead, { tags = [], note = "" } = {}) {
  // 1) partner por email (dedup)
  let partnerId = null;
  const found = await odooExec("res.partner", "search", [[["email", "=ilike", lead.email]]], { limit: 1 });
  if (found.length) {
    partnerId = found[0];
    await odooExec("res.partner", "write", [[partnerId], {
      name: lead.nombre, phone: lead.whatsapp || false,
      ...(lead.negocio ? { company_name: lead.negocio } : {}),
    }]);
  } else {
    partnerId = await odooExec("res.partner", "create", [{
      name: lead.nombre, email: lead.email, phone: lead.whatsapp || false,
      company_name: lead.negocio || false, comment: `Fuente: ${lead.source || "web"}`,
    }]);
  }
  // 2) crm.lead: reusar el abierto del mismo email o crear
  let leadId = null;
  const openLead = await odooExec("crm.lead", "search",
    [[["email_from", "=ilike", lead.email], ["active", "=", true]]], { limit: 1 });
  const tagIds = await odooTagIds(tags);
  const stageId = await odooStageId(stageNameForTags(tags));
  if (openLead.length) {
    leadId = openLead[0];
    const upd = { tag_ids: tagIds.map((t) => [4, t]) };
    if (stageId) upd.stage_id = stageId; // avanzar la etapa al re-tocar el lead (p.ej. diagnóstico→activación)
    await odooExec("crm.lead", "write", [[leadId], upd]);
  } else {
    const vals = {
      name: `${lead.negocio || lead.nombre} — ${lead.source || "web"}`,
      partner_id: partnerId, contact_name: lead.nombre, email_from: lead.email,
      phone: lead.whatsapp || false, tag_ids: tagIds.map((t) => [4, t]),
    };
    if (stageId) vals.stage_id = stageId;
    leadId = await odooExec("crm.lead", "create", [vals]);
  }
  // 3) nota al chatter. OJO: message_post vía RPC escapa el body (no acepta Markup) → el <br/> salía
  // como "&lt;br/&gt;" literal. Se pasa texto plano; el diagnóstico completo formateado va como
  // adjunto HTML (attachToLead), no en el body.
  if (note && leadId) {
    await odooExec("crm.lead", "message_post", [[leadId]], { body: note.slice(0, 8000) });
  }
  return { ok: true, driver: "odoo", id: leadId };
}

// Adjunta un archivo (base64) a la oportunidad como ir.attachment enlazado (res_model/res_id) →
// aparece en el clip de adjuntos del lead. Deja además una nota en el chatter para trazabilidad.
async function odooAttachToLead(leadId, { filename, mimetype = "text/html", base64 } = {}) {
  if (!leadId || !base64) return { ok: false, driver: "odoo", detail: "leadId y base64 requeridos" };
  // allowlist (no depender de que el caller ya haya hecho slugify): la función es segura por sí misma
  const safeName = String(filename || "adjunto").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  // idempotencia: si el mismo form se reenvía (doble click, reintento), no duplicar el adjunto
  const dup = await odooExec("ir.attachment", "search",
    [[["res_model", "=", "crm.lead"], ["res_id", "=", leadId], ["name", "=", safeName]]], { limit: 1 });
  if (dup.length) return { ok: true, driver: "odoo", attachmentId: dup[0], deduped: true };
  const attId = await odooExec("ir.attachment", "create", [{
    name: safeName, res_model: "crm.lead", res_id: leadId, type: "binary", datas: base64, mimetype,
  }]);
  await odooExec("crm.lead", "message_post", [[leadId]],
    { body: `Diagnóstico guardado como adjunto: ${safeName}`, attachment_ids: [attId] });
  return { ok: true, driver: "odoo", attachmentId: attId };
}

async function odooFindByEmail(email) {
  const ids = await odooExec("res.partner", "search", [[["email", "=ilike", email]]], { limit: 1 });
  if (!ids.length) return { found: false };
  const [p] = await odooExec("res.partner", "read", [ids, ["name", "phone", "company_name"]]);
  // tags: del crm.lead abierto más reciente de ese email
  let tags = [];
  const leadIds = await odooExec("crm.lead", "search",
    [[["email_from", "=ilike", email]]], { limit: 1, order: "id desc" });
  if (leadIds.length) {
    const [l] = await odooExec("crm.lead", "read", [leadIds, ["tag_ids"]]);
    if (l.tag_ids?.length) {
      const tagRecs = await odooExec("crm.tag", "read", [l.tag_ids, ["name"]]);
      tags = tagRecs.map((t) => t.name);
    }
  }
  return { found: true, nombre: p.name, negocio: p.company_name || "", phone: p.phone || "", tags };
}

/* ------------------------------- GHL (guardado) ------------------------------- */

async function ghlCall(method, path, body) {
  const r = await fetch(`${GHL_BASE}${path}`, {
    method,
    headers: { "Authorization": `Bearer ${GHL_TOKEN}`, "Version": GHL_VERSION,
      "Accept": "application/json", "Content-Type": "application/json",
      "User-Agent": "MinkaCRM/1.0" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = { _raw: txt }; }
  return { status: r.status, data };
}

async function ghlPushLead(lead, { tags = [], note = "" } = {}) {
  let contactId = null;
  const found = await ghlCall("GET",
    `/contacts/search/duplicate?locationId=${GHL_LOCATION}&email=${encodeURIComponent(lead.email)}`);
  if (found.status === 200 && found.data.contact) contactId = found.data.contact.id;
  const base = { locationId: GHL_LOCATION, name: lead.nombre, email: lead.email,
    phone: lead.whatsapp || undefined, companyName: lead.negocio || undefined,
    tags, source: lead.source || "web" };
  if (contactId) await ghlCall("PUT", `/contacts/${contactId}`, base);
  else {
    const created = await ghlCall("POST", "/contacts/", base);
    contactId = created.data?.contact?.id || null;
    if (!contactId) return { ok: false, driver: "ghl",
      detail: `create:${created.status}:${JSON.stringify(created.data).slice(0, 160)}` };
  }
  if (note && contactId) await ghlCall("POST", `/contacts/${contactId}/notes`, { body: note.slice(0, 4900) });
  return { ok: true, driver: "ghl", id: contactId };
}

async function ghlFindByEmail(email) {
  const r = await ghlCall("GET",
    `/contacts/search/duplicate?locationId=${GHL_LOCATION}&email=${encodeURIComponent(email)}`);
  const c = r.data?.contact;
  if (!c) return { found: false };
  return { found: true, nombre: c.firstName || c.name || "", negocio: c.companyName || "",
    phone: c.phone || "", tags: c.tags || [] };
}

/* --------------------------------- API pública --------------------------------- */

async function pushLead(lead, opts = {}) {
  const d = driver();
  try {
    if (d === "odoo") return await odooPushLead(lead, opts);
    if (d === "ghl") return await ghlPushLead(lead, opts);
    return { ok: false, driver: "none", detail: "CRM sin configurar (lead viaja por Telegram)" };
  } catch (e) {
    return { ok: false, driver: d, detail: String(e.message || e).slice(0, 200) };
  }
}

async function findByEmail(email) {
  const d = driver();
  try {
    if (d === "odoo") return await odooFindByEmail(email);
    if (d === "ghl") return await ghlFindByEmail(email);
    return { found: false, unavailable: true };
  } catch (e) {
    return { found: false, unavailable: true };
  }
}

// Adjunta un documento (p.ej. el HTML del diagnóstico) a una oportunidad. Sólo driver odoo:
// GHL queda guardado y "none" degrada honesto (el diagnóstico ya viajó por Telegram). Nunca lanza.
async function attachToLead(leadId, file) {
  const d = driver();
  try {
    if (d === "odoo") return await odooAttachToLead(leadId, file);
    return { ok: false, driver: d, skipped: true, detail: "attach sólo soportado en driver odoo" };
  } catch (e) {
    return { ok: false, driver: d, detail: String(e.message || e).slice(0, 200) };
  }
}

// `odooRpc` y `__resetUid` se exportan para el test del wake-retry (test/crm_retry.test.js); no son API pública.
module.exports = { pushLead, findByEmail, attachToLead, driver, odooRpc, __resetUid: () => { _uid = null; } };
