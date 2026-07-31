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
// MULTI-TENANT (2026-07-30): la plataforma Odoo de Minka es multi-DB — una DB por cliente, servida
// por el mismo binario (ver knowledge/odoo-infra-multitenant.md). Todas las funciones aceptan un
// `tenant` OPCIONAL; sin él se usan las ODOO_* de siempre (el CRM de Minka) y el comportamiento es
// idéntico al de antes. Con `tenant:"juanelo"` se leen ODOO_URL_JUANELO / ODOO_DB_JUANELO / etc.
//
// Contrato:
//   pushLead(lead, {tags, note, tenant})     → { ok, driver, id?, detail? }
//     lead = { nombre, email, whatsapp?, negocio?, source? }
//   findByEmail(email, {tenant})             → { found, nombre?, negocio?, phone?, tags: string[] } | { found:false }
//   attachToLead(leadId, file, {tenant})     → { ok, attachmentId?, deduped?, detail? }

const _envUrl = (s) => String(s || "").replace(/\/+$/, "");

// Mismo invariante que scripts/provision_crm.py: etiqueta de subdominio == nombre de DB. Un tenant
// válido en la plataforma produce siempre un sufijo de env válido.
const TENANT_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

// Resuelve las credenciales de UN tenant. Sin tenant → las ODOO_* globales (CRM de Minka).
//
// ⚠️ NO HAY FALLBACK AL TENANT POR DEFECTO. Si un tenant válido no tiene sus ODOO_*_<TENANT>
// configuradas, devuelve credenciales vacías → driver() da "none" → degradación honesta. Caer al
// default escribiría los datos de UN cliente en la base de OTRO (los postulantes de Juanelo dentro
// del CRM de Minka): un fallo de aislamiento multi-tenant, no una degradación.
//
// Se lee de process.env en cada llamada (no a load-time) porque el tenant es un parámetro de runtime.
function credsFor(tenant) {
  const t = String(tenant || "");
  if (!t) {
    return { tenant: "", url: _envUrl(process.env.ODOO_URL), db: process.env.ODOO_DB || "",
      user: process.env.ODOO_USER || "", apiKey: process.env.ODOO_API_KEY || "" };
  }
  // Un tenant inválido NO se normaliza en silencio: se rechaza. Normalizar permitiría que un valor
  // atacante-controlado ("../x", "URL") colapsara al sufijo de otro tenant o al global.
  if (!TENANT_RE.test(t)) throw new Error("crm-bad-tenant");
  const S = "_" + t.toUpperCase().replace(/-/g, "_");
  return { tenant: t, url: _envUrl(process.env["ODOO_URL" + S]), db: process.env["ODOO_DB" + S] || "",
    user: process.env["ODOO_USER" + S] || "", apiKey: process.env["ODOO_API_KEY" + S] || "" };
}

function driver(tenant) {
  const c = credsFor(tenant); // valida el tenant SIEMPRE (lanza antes de tocar nada si es inválido)
  const d = (process.env.CRM_DRIVER || "").toLowerCase();
  if (d) return d;
  if (c.url && c.db && c.apiKey) return "odoo";
  return "none";
}

/* ----------------------------- ODOO (JSON-RPC) ----------------------------- */

// Cache de uid POR TENANT (clave = nombre del tenant; "" = el global). Un cache único rompería el
// aislamiento: el uid de la DB `crm` no es válido en la DB `juanelo`, y reusarlo autenticaría contra
// la base equivocada o fallaría en cascada.
const _uidByTenant = Object.create(null);
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
async function odooRpc(service, method, args, { retries = 0, creds } = {}) {
  const c = creds || credsFor("");
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
      const r = await fetch(`${c.url}/jsonrpc`, {
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

async function odooUid(c) {
  if (_uidByTenant[c.tenant]) return _uidByTenant[c.tenant];
  // El authenticate es el 1er round-trip de todo el flujo → aquí pagamos y absorbemos el cold-start.
  const uid = await odooRpc("common", "authenticate", [c.db, c.user, c.apiKey, {}],
    { retries: ODOO_WAKE_RETRIES, creds: c });
  if (!uid) throw new Error("odoo-auth-failed");
  _uidByTenant[c.tenant] = uid;
  return uid;
}

async function odooExec(c, model, method, args, kwargs = {}) {
  const uid = await odooUid(c);
  try {
    return await odooRpc("object", "execute_kw", [c.db, uid, c.apiKey, model, method, args, kwargs],
      { creds: c });
  } catch (e) {
    // Auto-sanación: si el contenedor serverless sigue caliente pero Odoo volvió a dormir, el uid
    // cacheado apuntaría a una sesión muerta y todas las llamadas fallarían sin recuperarse.
    // Invalidarlo (SÓLO el de este tenant) fuerza un re-authenticate CON wake-retry en el próximo
    // push (no reintentamos ESTE create/write → sin dupes).
    _uidByTenant[c.tenant] = null;
    throw e;
  }
}

// Cache de ids de tag, con la MISMA clave por tenant que el de etapas (los ids son por base de
// datos). Sin esto, cada postulación gastaba 3-4 round-trips a Odoo resolviendo los mismos tags
// fijos — en el camino crítico de alguien en móvil esperando el 303. Ship-review 2026-07-30.
const _tagCache = Object.create(null);
async function odooTagIds(c, names) {
  const pendientes = names.filter((n) => _tagCache[`${c.tenant}\u0000${n}`] === undefined);
  // Las búsquedas no dependen entre sí: en paralelo en vez de una tras otra.
  const encontrados = await Promise.all(pendientes.map((name) =>
    odooExec(c, "crm.tag", "search", [[["name", "=", name]]], { limit: 1 })));
  for (let i = 0; i < pendientes.length; i++) {
    const name = pendientes[i];
    // El create sí va en serie: dos creates concurrentes del mismo nombre duplicarían el tag.
    _tagCache[`${c.tenant}\u0000${name}`] = encontrados[i].length
      ? encontrados[i][0]
      : await odooExec(c, "crm.tag", "create", [{ name }]);
  }
  return names.map((n) => _tagCache[`${c.tenant}\u0000${n}`]);
}

// Etapa del pipeline de la escalera Minka según los tags del lead (cache en module-scope, que
// persiste entre invocaciones "calientes" de la función serverless — igual que _uid).
//
// ⚠️ La clave incluye el TENANT. Los ids de crm.stage son por base de datos: la etapa "Lead nuevo"
// es el id 3 en `crm` y puede ser el 11 en `juanelo`. Con un cache global, el primer tenant que
// resolviera un nombre le impondría SU id a los demás → leads escritos en una etapa inexistente o
// equivocada de otra base. Separador NUL: no aparece ni en un slug ni en un nombre de etapa, así
// que ningún par (tenant, nombre) puede colisionar con otro.
const _stageCache = Object.create(null);
async function odooStageId(c, name) {
  const k = `${c.tenant}\u0000${name}`;
  if (_stageCache[k] !== undefined) return _stageCache[k];
  const found = await odooExec(c, "crm.stage", "search", [[["name", "=", name]]], { limit: 1 });
  _stageCache[k] = found.length ? found[0] : null;
  return _stageCache[k];
}
function stageNameForTags(tags) {
  const t = (tags || []).map((x) => String(x).toLowerCase());
  if (t.some((x) => x.startsWith("onboarding"))) return "Activacion solicitada";
  if (t.includes("diagnostico-p0")) return "Diagnosticado";
  // Las bases de cliente traen el pipeline estándar que crea provision_crm.py
  // ("Nuevo → Contactado → Cita agendada → Cliente → Recompra"). Sin esto, un lead de postulación
  // caería en la etapa por defecto de la plantilla de Odoo ("New", en inglés) y aparecería fuera
  // del pipeline que el cliente ve como suyo.
  if (t.includes("postulacion")) return "Nuevo";
  return "Lead nuevo";
}

// Escapa los comodines de SQL LIKE (% _ \) antes de usarlos con el operador `=ilike` de Odoo, que
// NO los sanea. Sin esto, un email como "%@%" (que pasa el `.includes("@")` de los endpoints) haría
// que `=ilike` casara un contacto ARBITRARIO — permitiendo sobrescribir (pushLead) o leer
// (findByEmail → portal-status) datos de OTRO cliente. Con emails normales es no-op; de hecho corrige
// un bug latente (el `_` de "john_doe@x.com" ya no actúa como comodín). Ship-review 2026-07-16.
const escLike = (s) => String(s ?? "").replace(/[\\%_]/g, "\\$&");

async function odooPushLead(c, lead, { tags = [], note = "" } = {}) {
  // 1) partner por email (dedup)
  let partnerId = null;
  const found = await odooExec(c, "res.partner", "search", [[["email", "=ilike", escLike(lead.email)]]], { limit: 1 });
  if (found.length) {
    partnerId = found[0];
    await odooExec(c, "res.partner", "write", [[partnerId], {
      name: lead.nombre, phone: lead.whatsapp || false,
      ...(lead.negocio ? { company_name: lead.negocio } : {}),
    }]);
  } else {
    partnerId = await odooExec(c, "res.partner", "create", [{
      name: lead.nombre, email: lead.email, phone: lead.whatsapp || false,
      company_name: lead.negocio || false, comment: `Fuente: ${lead.source || "web"}`,
    }]);
  }
  // 2) crm.lead: reusar el abierto del mismo email o crear
  let leadId = null;
  const openLead = await odooExec(c, "crm.lead", "search",
    [[["email_from", "=ilike", escLike(lead.email)], ["active", "=", true]]], { limit: 1 });
  const tagIds = await odooTagIds(c, tags);
  const stageId = await odooStageId(c, stageNameForTags(tags));
  if (openLead.length) {
    leadId = openLead[0];
    const upd = { tag_ids: tagIds.map((t) => [4, t]) };
    if (stageId) upd.stage_id = stageId; // avanzar la etapa al re-tocar el lead (p.ej. diagnóstico→activación)
    await odooExec(c, "crm.lead", "write", [[leadId], upd]);
  } else {
    const vals = {
      name: `${lead.negocio || lead.nombre} — ${lead.source || "web"}`,
      partner_id: partnerId, contact_name: lead.nombre, email_from: lead.email,
      phone: lead.whatsapp || false, tag_ids: tagIds.map((t) => [4, t]),
    };
    if (stageId) vals.stage_id = stageId;
    leadId = await odooExec(c, "crm.lead", "create", [vals]);
  }
  // 3) nota al chatter. OJO: message_post vía RPC escapa el body (no acepta Markup) → el <br/> salía
  // como "&lt;br/&gt;" literal. Se pasa texto plano; el diagnóstico completo formateado va como
  // adjunto HTML (attachToLead), no en el body.
  if (note && leadId) {
    await odooExec(c, "crm.lead", "message_post", [[leadId]], { body: note.slice(0, 8000) });
  }
  return { ok: true, driver: "odoo", id: leadId };
}

// Adjunta un archivo (base64) a la oportunidad como ir.attachment enlazado (res_model/res_id) →
// aparece en el clip de adjuntos del lead. Deja además una nota en el chatter para trazabilidad.
async function odooAttachToLead(c, leadId, { filename, mimetype = "text/html", base64, note } = {}) {
  if (!leadId || !base64) return { ok: false, driver: "odoo", detail: "leadId y base64 requeridos" };
  // allowlist (no depender de que el caller ya haya hecho slugify): la función es segura por sí misma
  const safeName = String(filename || "adjunto").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
  // idempotencia: si el mismo form se reenvía (doble click, reintento), no duplicar el adjunto
  const dup = await odooExec(c, "ir.attachment", "search",
    [[["res_model", "=", "crm.lead"], ["res_id", "=", leadId], ["name", "=", safeName]]], { limit: 1 });
  if (dup.length) return { ok: true, driver: "odoo", attachmentId: dup[0], deduped: true };
  const attId = await odooExec(c, "ir.attachment", "create", [{
    name: safeName, res_model: "crm.lead", res_id: leadId, type: "binary", datas: base64, mimetype,
  }]);
  await odooExec(c, "crm.lead", "message_post", [[leadId]],
    { body: note || `Diagnóstico guardado como adjunto: ${safeName}`, attachment_ids: [attId] });
  return { ok: true, driver: "odoo", attachmentId: attId };
}

async function odooFindByEmail(c, email) {
  const ids = await odooExec(c, "res.partner", "search", [[["email", "=ilike", escLike(email)]]], { limit: 1 });
  if (!ids.length) return { found: false };
  const [p] = await odooExec(c, "res.partner", "read", [ids, ["name", "phone", "company_name"]]);
  // tags: del crm.lead abierto más reciente de ese email
  let tags = [];
  const leadIds = await odooExec(c, "crm.lead", "search",
    [[["email_from", "=ilike", escLike(email)]]], { limit: 1, order: "id desc" });
  if (leadIds.length) {
    const [l] = await odooExec(c, "crm.lead", "read", [leadIds, ["tag_ids"]]);
    if (l.tag_ids?.length) {
      const tagRecs = await odooExec(c, "crm.tag", "read", [l.tag_ids, ["name"]]);
      tags = tagRecs.map((t) => t.name);
    }
  }
  return { found: true, nombre: p.name, negocio: p.company_name || "", phone: p.phone || "", tags };
}

// Escribe una nota en el chatter de una oportunidad, con dedup por marca. Lo usa el flujo de pago
// (Stripe) para que un reintento del webhook + el retorno del navegador no dejen dos notas del mismo
// cobro. La marca va DENTRO del cuerpo y se busca con `message_ids.body ilike` sobre ese lead.
async function odooNoteOnce(c, leadId, { body, mark } = {}) {
  if (!leadId || !body) return { ok: false, driver: "odoo", detail: "leadId y body requeridos" };
  if (mark) {
    const dup = await odooExec(c, "mail.message", "search",
      [[["model", "=", "crm.lead"], ["res_id", "=", leadId], ["body", "ilike", escLike(mark)]]], { limit: 1 });
    if (dup.length) return { ok: true, driver: "odoo", messageId: dup[0], deduped: true };
  }
  const id = await odooExec(c, "crm.lead", "message_post", [[leadId]], { body: String(body).slice(0, 8000) });
  return { ok: true, driver: "odoo", messageId: id };
}

// Agrega tags a una oportunidad existente sin tocar nada más (el pago no debe reescribir el lead).
async function odooTagLead(c, leadId, names = []) {
  if (!leadId || !names.length) return { ok: false, driver: "odoo", detail: "leadId y tags requeridos" };
  const tagIds = await odooTagIds(c, names);
  await odooExec(c, "crm.lead", "write", [[leadId], { tag_ids: tagIds.map((t) => [4, t]) }]);
  return { ok: true, driver: "odoo" };
}

/* --------------------------------- API pública --------------------------------- */

// `driver(tenant)` y `credsFor(tenant)` lanzan si el tenant es inválido → se resuelven DENTRO del try
// para que un tenant mal formado degrade igual que cualquier otro fallo del CRM (nunca revienta el
// endpoint) y devuelva el token diagnóstico `crm-bad-tenant`, que no contiene PII.
async function pushLead(lead, opts = {}) {
  let d = "none";
  try {
    d = driver(opts.tenant);
    if (d === "odoo") return await odooPushLead(credsFor(opts.tenant), lead, opts);
    return { ok: false, driver: "none", detail: "CRM sin configurar (lead viaja por Telegram)" };
  } catch (e) {
    return { ok: false, driver: d, detail: String(e.message || e).slice(0, 200) };
  }
}

async function findByEmail(email, opts = {}) {
  try {
    if (driver(opts.tenant) === "odoo") return await odooFindByEmail(credsFor(opts.tenant), email);
    return { found: false, unavailable: true };
  } catch (e) {
    return { found: false, unavailable: true };
  }
}

// Adjunta un documento (p.ej. el HTML del diagnóstico, o un reconocimiento del postulante) a una
// oportunidad. Sólo driver odoo; "none" degrada honesto. Nunca lanza.
async function attachToLead(leadId, file, opts = {}) {
  let d = "none";
  try {
    d = driver(opts.tenant);
    if (d === "odoo") return await odooAttachToLead(credsFor(opts.tenant), leadId, file);
    return { ok: false, driver: d, skipped: true, detail: "attach sólo soportado en driver odoo" };
  } catch (e) {
    return { ok: false, driver: d, detail: String(e.message || e).slice(0, 200) };
  }
}

// Nota idempotente en el chatter (dedup por `mark`). Para eventos que pueden llegar dos veces —
// p.ej. el mismo cobro de Stripe por el retorno del navegador Y por el webhook.
async function noteOnce(leadId, opts = {}) {
  let d = "none";
  try {
    d = driver(opts.tenant);
    if (d === "odoo") return await odooNoteOnce(credsFor(opts.tenant), leadId, opts);
    return { ok: false, driver: d, skipped: true, detail: "nota sólo soportada en driver odoo" };
  } catch (e) {
    return { ok: false, driver: d, detail: String(e.message || e).slice(0, 200) };
  }
}

// Agrega tags a una oportunidad ya existente, sin reescribir el resto del lead.
async function tagLead(leadId, names, opts = {}) {
  let d = "none";
  try {
    d = driver(opts.tenant);
    if (d === "odoo") return await odooTagLead(credsFor(opts.tenant), leadId, names);
    return { ok: false, driver: d, skipped: true, detail: "tags sólo soportados en driver odoo" };
  } catch (e) {
    return { ok: false, driver: d, detail: String(e.message || e).slice(0, 200) };
  }
}

// `odooRpc`, `escLike`, `credsFor` y `__resetUid` se exportan para los tests; no son API pública.
module.exports = {
  pushLead, findByEmail, attachToLead, noteOnce, tagLead, driver,
  odooRpc, escLike, credsFor,
  __resetUid: () => { for (const k of Object.keys(_uidByTenant)) delete _uidByTenant[k]; },
  __resetCaches: () => {
    for (const k of Object.keys(_uidByTenant)) delete _uidByTenant[k];
    for (const k of Object.keys(_stageCache)) delete _stageCache[k];
    for (const k of Object.keys(_tagCache)) delete _tagCache[k];
  },
};
