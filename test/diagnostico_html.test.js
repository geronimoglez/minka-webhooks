// test/diagnostico_html.test.js — Tests del renderer del diagnóstico (node puro, sin deps).
// Corre: `node test/diagnostico_html.test.js`. Exit 1 si falla algo.

const { renderDiagnosticoHTML, renderDiagnosticoEmail, slugify, activarUrl, telegramUrl, firstName,
  PLAN_LABEL } = require("../lib/diagnostico_html");

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log(" FAIL  " + label); }
}

const report = {
  resumen: "Eres una agencia en etapa temprana.",
  cuellos: [
    { titulo: "Servicios en la cabeza", detalle: "Sin paquetes claros." },
    { titulo: "Cada prospecto es especial", detalle: "Proceso manual." },
  ],
  quickwins: [
    { titulo: "Empaqueta tus ofertas", como: "Define 3 paquetes.", gratis: true },
    { titulo: "Kit de ventas", gratis: true },
  ],
  horas_semana: 6,
  plan: { slug: "respuesta-ia", porque: "Primero empaqueta, luego IA." },
};
const p = { nombre: "Gerónimo", negocio: "Minka Digital", email: "g@x.com" };

// 1) Estructura y contenido
const html = renderDiagnosticoHTML(p, report, { fecha: "2026-07-10" });
check(html.startsWith("<!doctype html>"), "es un documento HTML completo");
check(html.includes("Minka Digital"), "incluye el negocio");
check(html.includes("Eres una agencia en etapa temprana."), "incluye el resumen");
check(html.includes("Servicios en la cabeza"), "incluye cuello 1");
check(html.includes("~6 h"), "incluye la métrica de horas");
check(html.includes("Respuesta IA"), "traduce el slug del plan a label legible");
check((html.match(/class="freno"/g) || []).length === 2, "renderiza los 2 cuellos");
check((html.match(/class="win"/g) || []).length === 2, "renderiza los 2 quick wins");
check(html.includes("2026-07-10"), "incluye la fecha");

// 2) Escapado anti-inyección (input de usuario + salida del LLM)
const evilReport = {
  resumen: "<script>alert('xss')</script>",
  cuellos: [{ titulo: "<img src=x onerror=alert(1)>", detalle: "a & b < c" }],
  quickwins: [{ titulo: "\"><b>boom</b>", gratis: false }],
  horas_semana: "4",
  plan: { slug: "funnel-esencial", porque: "</p><script>evil()</script>" },
};
const evilP = { nombre: "<b>Hax</b>", negocio: "Ev'il & Co", email: "h@x.com" };
const evilHTML = renderDiagnosticoHTML(evilP, evilReport, {});
check(!evilHTML.includes("<script>alert"), "escapa <script> del resumen (no ejecuta)");
check(!evilHTML.includes("<img src=x onerror"), "escapa <img onerror> del cuello");
check(!evilHTML.includes("<script>evil()"), "escapa script del veredicto");
check(evilHTML.includes("&lt;script&gt;"), "el script queda como entidades escapadas");
check(evilHTML.includes("Ev&#39;il &amp; Co"), "escapa comilla y ampersand del negocio");
check(evilHTML.includes("Funnel Esencial"), "label del plan funnel-esencial");

// 3) slugify — seguro para nombre de archivo (sin acentos, sin traversal, acotado)
check(slugify("Minka Digital") === "minka-digital", "slugify básico");
check(slugify("Café Ñoño S.A.") === "cafe-nono-s-a", "slugify quita acentos/ñ");
check(slugify("../../etc/passwd") === "etc-passwd", "slugify neutraliza path traversal");
check(slugify("") === "diagnostico", "slugify vacío → default");
check(slugify(null) === "diagnostico", "slugify null → default");

// 4) Robustez ante report incompleto (LLM devolvió campos faltantes)
const partial = renderDiagnosticoHTML({}, { plan: {} }, {});
check(typeof partial === "string" && partial.includes("<!doctype"), "no truena con report vacío");
check(PLAN_LABEL["sistema-crecimiento"] === "Sistema de Crecimiento", "label sistema-crecimiento");

/* ---------------- FASE 2 — render de CORREO (lo que recibe el prospecto) ---------------- */

// 5) Contenido: el correo lleva el MISMO diagnóstico que el adjunto
const mail = renderDiagnosticoEmail(p, report, { fecha: "2026-07-29" });
check(mail.startsWith("<!doctype html>"), "correo: documento HTML completo");
check(mail.includes("Minka Digital"), "correo: incluye el negocio");
check(mail.includes("Eres una agencia en etapa temprana."), "correo: incluye el resumen");
check(mail.includes("Servicios en la cabeza") && mail.includes("Cada prospecto es especial"),
  "correo: incluye los 2 cuellos");
check(mail.includes("Empaqueta tus ofertas") && mail.includes("Kit de ventas"),
  "correo: incluye los 2 quick wins");
check(mail.includes(">gratis<"), "correo: marca el quick win gratis");
check(mail.includes("~6 horas"), "correo: incluye la métrica de horas");
check(mail.includes("Respuesta IA"), "correo: traduce el slug del plan a label legible");
check(mail.includes("Hola Gerónimo"), "correo: saluda por nombre de pila");
check(mail.includes("2026-07-29"), "correo: incluye la fecha");

// 6) CTA y enlaces — la razón de ser del correo es cerrar hacia /activar
check(mail.includes("https://www.minkadigital.com/activar?plan=respuesta-ia"),
  "correo: CTA a /activar con el plan recomendado");
check(mail.includes("https://www.minkadigital.com/portal"), "correo: enlaza el portal (puerta de regreso)");
check(mail.includes("https://www.minkadigital.com/privacidad"), "correo: enlaza el aviso de privacidad");
check(activarUrl("funnel-esencial") === "https://www.minkadigital.com/activar?plan=funnel-esencial",
  "activarUrl: slug válido lleva query");
// El slug lo inventa un LLM: nunca debe acabar crudo dentro de un href.
check(activarUrl("javascript:alert(1)") === "https://www.minkadigital.com/activar",
  "activarUrl: slug fuera de la allowlist cae a /activar (no se interpola)");
check(activarUrl("") === "https://www.minkadigital.com/activar", "activarUrl: slug vacío cae a /activar");
check(!renderDiagnosticoEmail(p, { ...report, plan: { slug: "no-existe", porque: "x" } }, {})
  .includes("no-existe"), "correo: un slug inventado no se imprime en ningún lado");

// 7) Compatibilidad con clientes de correo (el motivo de tener un render aparte del adjunto)
check(!mail.includes("var(--"), "correo: sin variables CSS (Gmail las borra)");
check(!/display\s*:\s*(flex|grid)/.test(mail), "correo: sin flex/grid (Outlook usa el motor de Word)");
check(!mail.includes("prefers-color-scheme"), "correo: sin media queries de tema");
check(!/<style[\s>]/.test(mail), "correo: todo el estilo va inline (no depende del <style> del head)");
check(mail.includes('role="presentation"'), "correo: maqueta con tablas accesibles");
check(mail.includes("max-width:600px"), "correo: ancho acotado a 600px");
check(mail.includes("Tu diagnóstico está listo: ~6 horas"), "correo: preheader con el gancho");

// 8) Escapado — mismo estándar que el adjunto (el correo se abre en un cliente que renderiza HTML)
const evilMail = renderDiagnosticoEmail(evilP, evilReport, {});
check(!evilMail.includes("<script>alert"), "correo: escapa <script> del resumen");
check(!evilMail.includes("<img src=x onerror"), "correo: escapa <img onerror> del cuello");
check(evilMail.includes("Ev&#39;il &amp; Co"), "correo: escapa comilla y ampersand del negocio");

// 9) Robustez — el LLM puede omitir secciones enteras
const partialMail = renderDiagnosticoEmail({ nombre: "Ana" }, { plan: {} }, {});
check(typeof partialMail === "string" && partialMail.includes("<!doctype"), "correo: no truena con report vacío");
check(!partialMail.includes("Lo que te está frenando"), "correo: omite la sección de cuellos si no hay");
check(partialMail.includes("Empieza con los quick wins"), "correo: sin plan válido, veredicto honesto");

// 10) firstName — el saludo sólo sale si parece un nombre de verdad
check(firstName("Gerónimo González") === "Gerónimo", "firstName: toma el nombre de pila");
check(firstName("3312345678") === "", "firstName: un teléfono no se saluda");
check(firstName("") === "" && firstName(null) === "", "firstName: vacío/null → sin saludo");
check(firstName("A") === "", "firstName: una letra suelta no es un nombre");
check(!renderDiagnosticoEmail({ nombre: "123", negocio: "X" }, report, {}).includes("Hola "),
  "correo: sin nombre usable, el saludo se omite (no queda 'Hola ,')");

/* ---------------- Deep-link a Telegram — bridge privacy-safe hacia el bot ---------------- */

// 11) telegramUrl — caso normal: negocio/giro válidos, plan conocido, horas redondeadas
const tgUrl = telegramUrl({ negocio: "Minka Digital", giro: "Marketing" },
  { horas_semana: 6, plan: { slug: "respuesta-ia" } });
check(typeof tgUrl === "string" && tgUrl.startsWith("https://t.me/"), "telegramUrl: arma un link de Telegram");
check(tgUrl.endsWith("?start=n-Minka-Digital_g-Marketing_p-R_h-6"),
  "telegramUrl: payload con negocio/giro/plan/horas correctos");

// 12) telegramUrl: mapea los 3 slugs de plan a su código de una letra
check(telegramUrl({ negocio: "X" }, { plan: { slug: "funnel-esencial" } }).includes("_p-F_"),
  "telegramUrl: funnel-esencial -> F");
check(telegramUrl({ negocio: "X" }, { plan: { slug: "sistema-crecimiento" } }).includes("_p-S_"),
  "telegramUrl: sistema-crecimiento -> S");

// 13) telegramUrl: slug de plan desconocido -> sin link (nunca asumas el plan barato)
check(telegramUrl({ negocio: "Minka" }, { plan: { slug: "plan-que-no-existe" } }) === null,
  "telegramUrl: slug de plan desconocido no cae a un plan por default");
check(telegramUrl({ negocio: "Minka" }, { plan: {} }) === null, "telegramUrl: sin plan.slug -> sin link");

// 14) telegramUrl: negocio que sanea a vacío (solo emoji/puntuación) -> sin link (rompería el saludo del bot)
check(telegramUrl({ negocio: "🎉🎉🎉" }, { plan: { slug: "respuesta-ia" } }) === null,
  "telegramUrl: negocio vacío tras sanear no genera link");
check(telegramUrl({ negocio: "" }, { plan: { slug: "respuesta-ia" } }) === null,
  "telegramUrl: negocio ausente no genera link");

// 15) telegramUrl: giro vacío es tolerable (solo negocio es obligatorio para el saludo)
const tgSinGiro = telegramUrl({ negocio: "Minka Digital" }, { plan: { slug: "respuesta-ia" } });
check(typeof tgSinGiro === "string" && tgSinGiro.includes("g-_p-R"),
  "telegramUrl: sin giro, igual arma el link (segmento vacío)");

// 16) telegramUrl: horas_semana ausente/no numérico -> horas=0 (no revienta, no cae a null)
check(telegramUrl({ negocio: "Minka" }, { plan: { slug: "respuesta-ia" } }).endsWith("_h-0"),
  "telegramUrl: sin horas_semana -> h-0");
check(telegramUrl({ negocio: "Minka" }, { horas_semana: "seis", plan: { slug: "respuesta-ia" } }).endsWith("_h-0"),
  "telegramUrl: horas_semana no numérico -> h-0");

// 17) telegramUrl: acentos/ñ se sanean igual que slugify (sin romper el charset del payload)
const tgAcentos = telegramUrl({ negocio: "Café Ñoño S.A.", giro: "Panadería" },
  { plan: { slug: "respuesta-ia" } });
check(/^https:\/\/t\.me\/[^?]+\?start=[A-Za-z0-9_-]{1,64}$/.test(tgAcentos),
  "telegramUrl: negocio/giro con acentos producen un payload limpio [A-Za-z0-9_-]");

// 18) telegramUrl: nunca lleva contacto (nombre/email/whatsapp) — el payload es público, viaja expuesto
const tgConContacto = telegramUrl({ negocio: "Minka", email: "g@x.com", whatsapp: "3312345678" },
  { plan: { slug: "respuesta-ia" } });
check(!tgConContacto.includes("x.com") && !tgConContacto.includes("3312345678"),
  "telegramUrl: nunca incluye email ni whatsapp en el payload");

console.log(`\n${"=".repeat(46)}\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
