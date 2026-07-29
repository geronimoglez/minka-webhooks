// test/diagnostico_flow.test.js — Test del flujo del handler del diagnóstico P0 (FASE 1, blindaje).
// Corre: `node test/diagnostico_flow.test.js`. Exit 1 si falla algo. Sin deps: stubea lib/crm y fetch.
//
// EL punto de todo el blindaje: el lead entra al CRM ANTES de depender del LLM.
//  A: el LLM falla del todo → 502 al usuario, pero el lead SÍ se guardó y Telegram SÍ avisó.
//  B: camino feliz → pushLead arranca ANTES del LLM y el enriquecimiento (nota + adjunto) va aparte.
//  C: si el push pre-LLM falla, el enriquecimiento reintenta el lead COMPLETO (con nota).
//  D: si el CRM falla del todo, el aviso de Telegram carga los datos del formulario (único registro).
//  E: si Odoo se arrastra, la respuesta NO se cuelga y NO se dispara un segundo push (ship-review).
//  F: FASE 2 — el prospecto RECIBE su diagnóstico por correo (la promesa del formulario).
//  G: doble submit del mismo día → un solo correo (no se spamea a alguien que apenas nos conoce).
//  H: si el correo falla, el usuario igual recibe su diagnóstico y el fallo queda en los logs.

process.env.OPENROUTER_API_KEY = "test-key";
process.env.DIAGNOSTICO_MODEL = "modelo/primario";
process.env.DIAGNOSTICO_MODEL_FALLBACK = "modelo/fallback";
process.env.TELEGRAM_BOT_TOKEN = "tg-token";
process.env.TELEGRAM_CHAT_ID = "42";
process.env.DIAGNOSTICO_BUDGET_MS = "500"; // presupuesto chico → el caso "Odoo lento" corre rápido

// Stub de lib/crm ANTES de requerir el handler: diagnostico.js guarda la referencia al MÓDULO
// (`const crm = require(...)`) y llama `crm.pushLead(...)` en runtime → mutar el objeto alcanza.
const crm = require("../lib/crm.js");
const calls = [];               // bitácora ordenada de efectos, para verificar el ORDEN
let crmBehavior = { push: "ok", delayMs: 0 }; // push: "ok" | "fail" | "failFirst"
let pushCount = 0;

crm.driver = () => "odoo";
crm.pushLead = async (lead, opts) => {
  pushCount++;
  calls.push({ fn: "pushLead", tags: (opts && opts.tags) || [], hasNote: !!(opts && opts.note), email: lead.email });
  if (crmBehavior.delayMs) await new Promise((r) => setTimeout(r, crmBehavior.delayMs));
  const failThis = crmBehavior.push === "fail" || (crmBehavior.push === "failFirst" && pushCount === 1);
  return failThis ? { ok: false, driver: "odoo", detail: "odoo-rejected:Test" }
                  : { ok: true, driver: "odoo", id: 777 };
};
crm.addLeadNote = async (leadId, note) => {
  calls.push({ fn: "addLeadNote", leadId, noteLen: note.length });
  return { ok: true, driver: "odoo", id: leadId };
};
crm.attachToLead = async (leadId, file) => {
  calls.push({ fn: "attachToLead", leadId, filename: file.filename });
  // `deduped` = el mismo diagnóstico ya estaba archivado (doble submit del mismo día).
  return { ok: true, driver: "odoo", attachmentId: 99, ...(crmBehavior.attDeduped ? { deduped: true } : {}) };
};
crm.sendLeadEmail = async (leadId, m) => {
  calls.push({ fn: "sendLeadEmail", leadId, to: m.to, subject: m.subject, from: m.from,
    replyTo: m.replyTo, html: m.html });
  return crmBehavior.mail === "fail"
    ? { ok: false, driver: "odoo", detail: "odoo-rejected:MailDeliveryException" }
    : { ok: true, driver: "odoo", mailId: 5 };
};

const handler = require("../api/diagnostico.js");

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log(" FAIL  " + label); }
}

const OK_REPORT = {
  resumen: "Negocio local con mensajes que se le escapan.",
  cuellos: [{ titulo: "c1", detalle: "d1" }],
  quickwins: [{ titulo: "q1", como: "paso", gratis: true }],
  horas_semana: 8,
  plan: { slug: "respuesta-ia", porque: "apenas arranca" },
};

const BODY = {
  nombre: "Ana", email: "Ana@Ejemplo.com", whatsapp: "3312345678", negocio: "Tacos Ana",
  giro: "comida", etapa: "pyme-operando", canal: "WhatsApp", dolor: "no alcanzo a contestar",
  procesos: "responder mensajes", volumen: "20 a 60 por semana", sitio: "",
};

// `llm`: "ok" | "fail". Registra en `calls` cada salida (openrouter / telegram) para ver el orden.
function mockFetch(llm) {
  global.fetch = async (url, opts) => {
    if (String(url).includes("openrouter")) {
      calls.push({ fn: "llm" });
      if (llm === "fail") return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(OK_REPORT) } }] }) };
    }
    if (String(url).includes("telegram")) {
      calls.push({ fn: "telegram", text: JSON.parse(opts.body).text });
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error("fetch inesperado a " + url);
  };
}

function fakeRes() {
  const out = { code: null, body: null, headers: {} };
  const res = {
    setHeader: (k, v) => { out.headers[k] = v; },
    status: (c) => { out.code = c; return res; },
    json: (b) => { out.body = b; return res; },
    end: () => res,
  };
  return { res, out };
}

async function run(body, { llm = "ok", push = "ok", delayMs = 0, attDeduped = false, mail = "ok" } = {}) {
  calls.length = 0; pushCount = 0; crmBehavior = { push, delayMs, attDeduped, mail };
  mockFetch(llm);
  const { res, out } = fakeRes();
  // IP distinta por corrida: el rate-limit es module-scope y persiste entre casos del test.
  const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
  await handler({ method: "POST", headers: { origin: "https://www.minkadigital.com", "x-forwarded-for": ip },
    body }, res);
  return out;
}

const realLog = console.error;

(async () => {
  console.log("A — el LLM falla del todo: el lead NO se pierde");
  console.error = () => {};
  let out = await run(BODY, { llm: "fail" });
  console.error = realLog;
  const pushA = calls.find((c) => c.fn === "pushLead");
  const tgA = calls.find((c) => c.fn === "telegram");
  check(out.code === 502, "A: el usuario recibe 502 (el diagnóstico no salió)");
  check(!!pushA, "A: pese al fallo del LLM, el lead SÍ se guardó en el CRM");
  check(pushA && pushA.tags.includes("diagnostico-p0"), "A: el lead lleva el tag `diagnostico-p0`");
  check(pushA && pushA.email === "ana@ejemplo.com", "A: el email va normalizado a minúsculas");
  check(!!tgA, "A: Telegram avisó igual (antes sólo avisaba en el camino feliz)");
  check(tgA && tgA.text.includes("SIN diagnóstico"), "A: el aviso dice claramente que el LLM falló");
  check(tgA && tgA.text.includes("no alcanzo a contestar"), "A: el aviso lleva el dolor del prospecto");

  console.log("B — camino feliz: el lead va ANTES del LLM, el enriquecimiento después");
  out = await run(BODY, { llm: "ok" });
  const order = calls.map((c) => c.fn);
  check(out.code === 200 && out.body.ok === true, "B: 200 con el reporte");
  check(out.body.report.cuellos.length === 1, "B: el reporte llega normalizado al front");
  check(order.indexOf("pushLead") < order.indexOf("llm"),
    "B: pushLead arranca ANTES del LLM (" + order.join(" → ") + ")");
  check(pushCount === 1, "B: un solo pushLead (el enriquecimiento no lo repite)");
  const noted = calls.find((c) => c.fn === "addLeadNote");
  check(noted && noted.leadId === 777 && noted.noteLen > 100, "B: la nota se cuelga con 1 RPC (addLeadNote)");
  const att = calls.find((c) => c.fn === "attachToLead");
  check(att && /^diagnostico-tacos-ana-\d{4}-\d{2}-\d{2}\.html$/.test(att.filename),
    "B: el HTML durable se adjunta a la oportunidad (" + (att && att.filename) + ")");
  check(calls.some((c) => c.fn === "telegram"), "B: Telegram avisa del lead bueno");

  console.log("C — el push pre-LLM falla: el enriquecimiento reintenta el lead completo");
  console.error = () => {};
  out = await run(BODY, { llm: "ok", push: "failFirst" });
  console.error = realLog;
  check(out.code === 200, "C: el usuario igual recibe su diagnóstico");
  check(pushCount === 2, "C: hubo un segundo pushLead de rescate");
  const rescue = calls.filter((c) => c.fn === "pushLead")[1];
  check(rescue && rescue.hasNote === true, "C: el rescate lleva la nota del diagnóstico incluida");
  check(calls.some((c) => c.fn === "attachToLead"), "C: y el adjunto se guarda igual");

  console.log("D — CRM caído del todo: Telegram queda como único registro");
  console.error = () => {};
  out = await run(BODY, { llm: "fail", push: "fail" });
  console.error = realLog;
  const tgD = calls.find((c) => c.fn === "telegram");
  check(tgD && tgD.text.includes("único registro"), "D: el aviso avisa que es el único registro");
  check(tgD && tgD.text.includes("20 a 60 por semana") && tgD.text.includes("responder mensajes"),
    "D: y carga volumen/canal/procesos para poder cargarlo a mano");

  console.log("E — Odoo lento: la respuesta no se cuelga y NO se dispara un segundo push");
  console.error = () => {};
  const t0 = Date.now();
  // El push tarda 1.5 s con un presupuesto de 500 ms → al responder sigue PENDIENTE (no fallido).
  out = await run(BODY, { llm: "ok", push: "ok", delayMs: 1500 });
  const elapsed = Date.now() - t0;
  console.error = realLog;
  check(out.code === 200, "E: el usuario igual recibe su diagnóstico");
  check(pushCount === 1, "E: UN solo push (un pendiente no debe confundirse con un fallo → sin duplicados)");
  check(calls.some((c) => c.fn === "addLeadNote"), "E: el enriquecimiento espera al mismo push y cuelga la nota");
  const tgE = calls.find((c) => c.fn === "telegram");
  check(tgE && !tgE.text.includes("único registro"),
    "E: Telegram NO declara al CRM caído por ir lento");
  check(elapsed < 5000, `E: nada se cuelga esperando indefinidamente (${elapsed} ms)`);

  console.log("F — FASE 2: el prospecto recibe su diagnóstico por correo");
  out = await run(BODY, { llm: "ok" });
  const mailF = calls.find((c) => c.fn === "sendLeadEmail");
  check(!!mailF, "F: se manda el correo del diagnóstico (antes la página lo prometía y nada lo mandaba)");
  check(mailF && mailF.to === "ana@ejemplo.com", "F: va al correo que capturó el formulario");
  check(mailF && mailF.leadId === 777, "F: colgado del MISMO lead (queda en su chatter)");
  check(mailF && mailF.subject === "Tu diagnóstico digital, Tacos Ana", "F: asunto con el nombre del negocio");
  check(mailF && mailF.from === "", "F: sin remitente propio → usa el que Odoo ya tiene verificado en SES");
  check(mailF && mailF.replyTo === "hola@minkadigital.com", "F: las respuestas caen en un buzón que se lee");
  check(mailF && mailF.html.includes("/activar?plan=respuesta-ia"), "F: el correo cierra con CTA a /activar");
  check(mailF && mailF.html.includes("Tacos Ana") && mailF.html.includes("c1"),
    "F: el correo lleva el diagnóstico real, no un aviso genérico");
  const orderF = calls.map((c) => c.fn);
  check(orderF.indexOf("sendLeadEmail") > orderF.indexOf("attachToLead"),
    "F: el correo va DESPUÉS de guardar lead y adjunto (lo no perdible primero)");

  console.log("G — el front sabe si el correo va en camino (para no prometer de más)");
  check(out.body.mail === true, "G: con driver odoo y envío encendido, la respuesta trae mail:true");
  crm.driver = () => "none";
  out = await run(BODY, { llm: "ok" });
  crm.driver = () => "odoo";
  check(out.body.mail === false,
    "G: sin CRM configurado, mail:false → la pantalla no promete un correo que no sale");
  // Un segundo diagnóstico del mismo negocio SÍ genera su propio correo: es un reporte nuevo, y
  // saltárselo dejaría al prospecto sin nada si el primero falló (hallazgo de ship-review).
  out = await run(BODY, { llm: "ok", attDeduped: true });
  check(calls.some((c) => c.fn === "sendLeadEmail"),
    "G: un adjunto dedupeado NO suprime el correo (cada diagnóstico nuevo se entrega)");

  console.log("H — el correo falla: el diagnóstico igual llega a pantalla y el fallo se registra");
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  out = await run(BODY, { llm: "ok", mail: "fail" });
  console.error = realLog;
  check(out.code === 200 && out.body.ok === true, "H: un fallo de correo NO rompe la respuesta al usuario");
  check(calls.some((c) => c.fn === "attachToLead"), "H: el lead y el adjunto siguen guardados");
  check(logged.some((l) => l.includes("correo al prospecto falló")),
    "H: el fallo queda visible en los logs");
  check(logged.some((l) => l.includes("MailDeliveryException")) && !logged.some((l) => l.includes("ana@ejemplo.com")),
    "H: se loguea la CLASE del error, nunca el correo del prospecto (PII)");
  // Los logs de Vercel no los mira nadie: el fallo tiene que llegar al canal que Gerónimo sí lee.
  const alert = calls.filter((c) => c.fn === "telegram").find((c) => c.text.includes("No pude mandarle"));
  check(!!alert, "H: además avisa por Telegram (si no, un correo caído volvería a ser invisible)");
  check(alert && alert.text.includes("ana@ejemplo.com") && alert.text.includes("MailDeliveryException"),
    "H: el aviso lleva a quién y por qué falló, para poder reenviarlo a mano");

  console.log("I — el LLM falló: no hay diagnóstico que mandar, no se manda correo");
  console.error = () => {};
  out = await run(BODY, { llm: "fail" });
  console.error = realLog;
  check(!calls.some((c) => c.fn === "sendLeadEmail"),
    "I: sin reporte no sale correo (nada peor que mandar un diagnóstico vacío)");

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
