// lib/crm.js — Adaptador CRM de Minka (Odoo es el CRM; GHL purgado 2026-07-16, decisión Gerónimo).
//
// Un solo contrato para todos los endpoints; el backend real se elige por env:
//   CRM_DRIVER = "odoo" | "none"   (default: auto → odoo si hay ODOO_URL+DB+API_KEY, si no "none")
// Driver "none" = degradación honesta: los endpoints siguen funcionando (el lead viaja completo
// por Telegram) y responden crm:"skipped". Nada se rompe si el CRM está caído o sin configurar.
//
// Odoo: API externa estándar JSON-RPC (/jsonrpc, service object.execute_kw) — funciona igual en
// Odoo Online, Odoo.sh y Community self-hosted. Modelos: res.partner (contacto) + crm.lead
// (oportunidad) + chatter (message_post) para las notas de diagnóstico/onboarding.
//
// GHL: SALIMOS de GoHighLevel (2026-07-16). Se eliminó el driver "ghl" y sus credenciales; ya no
// existe forma de que un lead se escriba a GHL. Si algún día se reintroduce otro CRM, se agrega
// como un driver nuevo aquí — no se resucita GHL.
//
// Contrato:
//   pushLead(lead, {tags, note})  → { ok, driver, id?, detail? }
//     lead = { nombre, email, whatsapp?, negocio?, source? }
//   findByEmail(email)            → { found, nombre?, negocio?, phone?, tags: string[] } | { found:false }
//   addLeadNote(leadId, note)     → { ok, driver, id?, detail? }        (enriquecer un lead ya creado)
//   attachToLead(leadId, file)    → { ok, driver, attachmentId?, detail? }
//   sendLeadEmail(leadId, mail)   → { ok, driver, mailId?, detail? }    (correo al prospecto + chatter)

const ODOO_URL = (process.env.ODOO_URL || "").replace(/\/+$/, "");
const ODOO_DB = process.env.ODOO_DB || "";
const ODOO_USER = process.env.ODOO_USER || "";
const ODOO_API_KEY = process.env.ODOO_API_KEY || "";

function driver() {
  const d = (process.env.CRM_DRIVER || "").toLowerCase();
  if (d) return d;
  if (ODOO_URL && ODOO_DB && ODOO_API_KEY) return "odoo";
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
    // error de negocio de Odoo (auth, validación) = real → NO reintentar (fuera del try de reintento).
    // PRIVACIDAD (ship-review 2026-07-13): NO propagar data.error.data.message — ese mensaje humano
    // puede eco-ar PII del prospecto. Casos reales confirmados: (1) ValidationError de @api.constrains
    // que interpola email/teléfono/nombre; (2) UniqueViolation SQL cruda con "DETAIL: Key (email)=(...)".
    // Ese `detail` viajaba a la respuesta HTTP pública (onboarding.js) y a los logs (diagnostico.js).
    // Sólo propagamos la CLASE de excepción (data.error.data.name, p.ej. "ValidationError"): diagnóstica
    // y libre de PII. El mensaje crudo se queda en Odoo (visible en su backend para depurar de verdad).
    if (data.error) {
      const cls = String(data.error?.data?.name || "").split(".").pop() || "OdooError";
      throw new Error(`odoo-rejected:${cls}`);
    }
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

// Escapa los comodines de SQL LIKE (% _ \) antes de usarlos con el operador `=ilike` de Odoo, que
// NO los sanea. Sin esto, un email como "%@%" (que pasa el `.includes("@")` de los endpoints) haría
// que `=ilike` casara un contacto ARBITRARIO — permitiendo sobrescribir (pushLead) o leer
// (findByEmail → portal-status) datos de OTRO cliente. Con emails normales es no-op; de hecho corrige
// un bug latente (el `_` de "john_doe@x.com" ya no actúa como comodín). Ship-review 2026-07-16.
const escLike = (s) => String(s ?? "").replace(/[\\%_]/g, "\\$&");

async function odooPushLead(lead, { tags = [], note = "" } = {}) {
  // 1) partner por email (dedup)
  let partnerId = null;
  const found = await odooExec("res.partner", "search", [[["email", "=ilike", escLike(lead.email)]]], { limit: 1 });
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
    [[["email_from", "=ilike", escLike(lead.email)], ["active", "=", true]]], { limit: 1 });
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

// Publica una nota en el chatter de una oportunidad ya existente. Existe para que un endpoint pueda
// guardar el lead PRIMERO (pushLead sin nota) y enriquecerlo DESPUÉS con 1 sola RPC, en vez de
// repetir el pushLead completo (~8 RPCs: search partner, write, search lead, tags, stage, post).
async function odooAddLeadNote(leadId, note) {
  await odooExec("crm.lead", "message_post", [[leadId]], { body: String(note).slice(0, 8000) });
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

// Manda un correo AL PROSPECTO desde Odoo (mail.mail → addon minka_ses → API de AWS SES) y lo deja
// registrado en el chatter de la oportunidad. FASE 2: la página prometía "aquí te mandamos el
// diagnóstico" y nada lo mandaba (auditoría 2026-07-29 §3).
//
// Por qué por Odoo y no con un SDK de correo aquí: es EXACTAMENTE el camino que ya usa
// `scripts/p0_nurture.py` del repo principal en producción (nurturing día 2/7). Cero infra nueva,
// cero credenciales nuevas en Vercel, misma identidad verificada en SES y misma reputación de
// dominio — meter un segundo remitente sería la forma más rápida de romper el DKIM/SPF que ya sirve.
//
// REMITENTE: NO se pasa `email_from` por default, igual que p0_nurture.py → Odoo usa el suyo
// (res.company.email = noreply@minkadigital.com, ver scripts/provision_crm.py). Cambiarlo desde aquí
// mandaría a SES una Source distinta y, si esa dirección no es identidad verificada, TODO el correo
// dejaría de salir. El `from` es override explícito y consciente; el `replyTo` (que no toca el sobre
// ni la reputación) es la forma barata de que el prospecto conteste a un buzón que alguien lee.
async function odooSendLeadEmail(leadId, { to, subject, html, from = "", replyTo = "" } = {}) {
  // SEGURIDAD: estos valores acaban como CABECERAS de correo, construidas del lado de Odoo/Python.
  // Un salto de línea en el asunto o en el destinatario permitiría inyectar cabeceras propias
  // (`Bcc:`, `Reply-To:`) — y el asunto lleva el NOMBRE DEL NEGOCIO, que lo escribe el visitante.
  // El endpoint sólo valida que el correo tenga "@", así que se sanea aquí, en el sink.
  const hdr = (v) => String(v ?? "").replace(/[\r\n\t\v\f\u0000-\u001f\u007f]+/g, " ").trim();
  const addr = hdr(to);
  // Una sola dirección, estricta. `email_to` de Odoo acepta lista separada por comas: sin esta
  // guarda, un "yo@x.com,victima@y.com" convertiría el formulario público en un relay para mandarle
  // correo a terceros. Si no pasa, no se manda nada — el lead sigue en el CRM y Telegram ya avisó.
  if (!/^[^\s,;:<>"'\\]+@[^\s,;:<>"'\\]+\.[^\s,;:<>"'\\]+$/.test(addr) || !html) {
    return { ok: false, driver: "odoo", detail: "destinatario o cuerpo inválidos" };
  }
  const vals = {
    subject: hdr(subject || "Tu diagnóstico digital").slice(0, 200),
    body_html: String(html),
    email_to: addr,
    // El registro sobrevive al envío: es la bitácora auditable de qué se mandó y en qué estado
    // quedó (con auto_delete Odoo lo borra y no queda rastro de un fallo de entrega).
    auto_delete: false,
  };
  if (from) vals.email_from = hdr(from);
  if (replyTo) vals.reply_to = hdr(replyTo);
  const mailId = await odooExec("mail.mail", "create", [vals]);
  // `raise_exception: true` es deliberado. Por default `send()` NO lanza: marca el registro con
  // state="exception" y devuelve normal → un rechazo de SES (identidad no verificada, cuota, bounce
  // duro) sería INVISIBLE en los logs de Vercel y volveríamos a prometer un correo que no sale.
  // Con esta bandera el fallo llega como `odoo-rejected:MailDeliveryException` (clase, sin PII: el
  // mensaje crudo de SES lleva el correo del prospecto y se queda en Odoo, ver odooRpc).
  await odooExec("mail.mail", "send", [[mailId]], { raise_exception: true });
  // Nota en el chatter DESPUÉS del envío: si el send falla, esta línea no corre y el historial del
  // lead nunca afirma un envío que no ocurrió. Mismo patrón que p0_nurture.py.
  if (leadId) {
    await odooExec("crm.lead", "message_post", [[leadId]],
      { body: `📧 Diagnóstico enviado por correo a ${addr.slice(0, 120)}.` });
  }
  return { ok: true, driver: "odoo", mailId };
}

async function odooFindByEmail(email) {
  const ids = await odooExec("res.partner", "search", [[["email", "=ilike", escLike(email)]]], { limit: 1 });
  if (!ids.length) return { found: false };
  const [p] = await odooExec("res.partner", "read", [ids, ["name", "phone", "company_name"]]);
  // tags: del crm.lead abierto más reciente de ese email
  let tags = [];
  const leadIds = await odooExec("crm.lead", "search",
    [[["email_from", "=ilike", escLike(email)]]], { limit: 1, order: "id desc" });
  if (leadIds.length) {
    const [l] = await odooExec("crm.lead", "read", [leadIds, ["tag_ids"]]);
    if (l.tag_ids?.length) {
      const tagRecs = await odooExec("crm.tag", "read", [l.tag_ids, ["name"]]);
      tags = tagRecs.map((t) => t.name);
    }
  }
  return { found: true, nombre: p.name, negocio: p.company_name || "", phone: p.phone || "", tags };
}

/* --------------------------------- API pública --------------------------------- */

async function pushLead(lead, opts = {}) {
  const d = driver();
  try {
    if (d === "odoo") return await odooPushLead(lead, opts);
    return { ok: false, driver: "none", detail: "CRM sin configurar (lead viaja por Telegram)" };
  } catch (e) {
    return { ok: false, driver: d, detail: String(e.message || e).slice(0, 200) };
  }
}

async function findByEmail(email) {
  const d = driver();
  try {
    if (d === "odoo") return await odooFindByEmail(email);
    return { found: false, unavailable: true };
  } catch (e) {
    return { found: false, unavailable: true };
  }
}

// Agrega una nota al chatter de una oportunidad existente. Sólo driver odoo; "none" degrada
// honesto. Nunca lanza (mismo contrato que attachToLead).
async function addLeadNote(leadId, note) {
  const d = driver();
  if (!leadId || !note) return { ok: false, driver: d, detail: "leadId y note requeridos" };
  try {
    if (d === "odoo") return await odooAddLeadNote(leadId, note);
    return { ok: false, driver: d, skipped: true, detail: "nota sólo soportada en driver odoo" };
  } catch (e) {
    return { ok: false, driver: d, detail: String(e.message || e).slice(0, 200) };
  }
}

// Adjunta un documento (p.ej. el HTML del diagnóstico) a una oportunidad. Sólo driver odoo;
// "none" degrada honesto (el diagnóstico ya viajó por Telegram). Nunca lanza.
async function attachToLead(leadId, file) {
  const d = driver();
  try {
    if (d === "odoo") return await odooAttachToLead(leadId, file);
    return { ok: false, driver: d, skipped: true, detail: "attach sólo soportado en driver odoo" };
  } catch (e) {
    return { ok: false, driver: d, detail: String(e.message || e).slice(0, 200) };
  }
}

// Manda el correo al prospecto y lo registra en el chatter del lead. Sólo driver odoo; "none"
// degrada honesto. Nunca lanza (mismo contrato que attachToLead).
async function sendLeadEmail(leadId, mail) {
  const d = driver();
  try {
    if (d === "odoo") return await odooSendLeadEmail(leadId, mail);
    return { ok: false, driver: d, skipped: true, detail: "correo sólo soportado en driver odoo" };
  } catch (e) {
    return { ok: false, driver: d, detail: String(e.message || e).slice(0, 200) };
  }
}

// `odooRpc`, `escLike` y `__resetUid` se exportan para los tests (test/crm_retry.test.js); no son API pública.
module.exports = { pushLead, findByEmail, addLeadNote, attachToLead, sendLeadEmail, driver, odooRpc, escLike, __resetUid: () => { _uid = null; } };
