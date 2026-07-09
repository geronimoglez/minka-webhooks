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
async function odooRpc(service, method, args) {
  const r = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", id: Date.now(),
      params: { service, method, args } }),
  });
  const data = await r.json();
  if (data.error) throw new Error(data.error?.data?.message || data.error.message || "odoo-error");
  return data.result;
}

async function odooUid() {
  if (_uid) return _uid;
  _uid = await odooRpc("common", "authenticate", [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
  if (!_uid) throw new Error("odoo-auth-failed");
  return _uid;
}

async function odooExec(model, method, args, kwargs = {}) {
  const uid = await odooUid();
  return odooRpc("object", "execute_kw", [ODOO_DB, uid, ODOO_API_KEY, model, method, args, kwargs]);
}

async function odooTagIds(names) {
  const ids = [];
  for (const name of names) {
    const found = await odooExec("crm.tag", "search", [[["name", "=", name]]], { limit: 1 });
    ids.push(found.length ? found[0] : await odooExec("crm.tag", "create", [{ name }]));
  }
  return ids;
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
  if (openLead.length) {
    leadId = openLead[0];
    if (tagIds.length) await odooExec("crm.lead", "write",
      [[leadId], { tag_ids: tagIds.map((t) => [4, t]) }]);
  } else {
    leadId = await odooExec("crm.lead", "create", [{
      name: `${lead.negocio || lead.nombre} — ${lead.source || "web"}`,
      partner_id: partnerId, contact_name: lead.nombre, email_from: lead.email,
      phone: lead.whatsapp || false, tag_ids: tagIds.map((t) => [4, t]),
    }]);
  }
  // 3) nota al chatter
  if (note && leadId) {
    await odooExec("crm.lead", "message_post", [[leadId]],
      { body: note.replace(/\n/g, "<br/>").slice(0, 8000) });
  }
  return { ok: true, driver: "odoo", id: leadId };
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

module.exports = { pushLead, findByEmail, driver };
