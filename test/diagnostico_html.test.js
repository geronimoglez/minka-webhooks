// test/diagnostico_html.test.js — Tests del renderer del diagnóstico (node puro, sin deps).
// Corre: `node test/diagnostico_html.test.js`. Exit 1 si falla algo.

const { renderDiagnosticoHTML, slugify, PLAN_LABEL } = require("../lib/diagnostico_html");

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

console.log(`\n${"=".repeat(46)}\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
