// lib/diagnostico_html.js — Render del diagnóstico P0 a un HTML autocontenido y durable.
//
// Se guarda como adjunto (ir.attachment) en la oportunidad de Odoo para que el diagnóstico NO se
// evapore (antes sólo se devolvía al browser + resumen a Telegram). Reusable/testeable aparte de
// api/diagnostico.js. TODO el contenido dinámico (input del usuario + salida del LLM) se ESCAPA:
// el HTML queda archivado y se abre después, así que un dato con <script> no debe ejecutarse.

const PLAN_LABEL = {
  "respuesta-ia": "Respuesta IA",
  "funnel-esencial": "Funnel Esencial",
  "sistema-crecimiento": "Sistema de Crecimiento",
};

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// slug seguro para el nombre de archivo (sin PII cruda, sin path traversal)
function slugify(v) {
  return String(v || "diagnostico").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "diagnostico";
}

function renderDiagnosticoHTML(p = {}, report = {}, opts = {}) {
  const fecha = esc(opts.fecha || "");
  const plan = report.plan || {};
  const planLabel = PLAN_LABEL[plan.slug] || esc(plan.slug || "—");
  const cuellos = Array.isArray(report.cuellos) ? report.cuellos : [];
  const wins = Array.isArray(report.quickwins) ? report.quickwins : [];

  const cuellosHTML = cuellos.map((c, i) => `
      <article class="freno">
        <span class="n">${i + 1}</span>
        <div><h3>${esc(c && c.titulo)}</h3><p>${esc(c && c.detalle)}</p></div>
      </article>`).join("");

  const winsHTML = wins.map((q) => `
      <div class="win"><span class="check">&#10003;</span><div class="body">
        <h3>${esc(q && q.titulo)} ${q && q.gratis ? '<span class="free">gratis</span>' : ""}</h3>
        ${q && q.como ? `<p>${esc(q.como)}</p>` : ""}
      </div></div>`).join("");

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diagnóstico Minka — ${esc(p.negocio || p.nombre || "")}</title>
<style>
  :root{--paper:#f5f7f2;--card:#fff;--ink:#191d16;--muted:#5f675a;--line:#e2e7dc;
    --green:#12734d;--green-soft:#e5efe7;--green-ink:#0d5238;--brick:#b6402c}
  @media (prefers-color-scheme:dark){:root{--paper:#0f120d;--card:#171b14;--ink:#eef1e9;
    --muted:#9aa393;--line:#28301f;--green:#4fbf8a;--green-soft:#152a1f;--green-ink:#8fe0b6;--brick:#e8795f}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);line-height:1.6;
    font-family:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif}
  .wrap{max-width:740px;margin:0 auto;padding:clamp(20px,5vw,52px) clamp(18px,5vw,40px) 64px}
  .top{display:flex;justify-content:space-between;align-items:center;margin-bottom:40px}
  .brand{display:flex;align-items:center;gap:9px;font-weight:600}
  .dot{width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,var(--green),var(--brick))}
  .pill{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--green-ink);
    background:var(--green-soft);border:1px solid var(--line);padding:5px 12px;border-radius:999px}
  .eyebrow{font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--green);margin:0 0 10px}
  h1{font-size:clamp(30px,6vw,46px);line-height:1.04;letter-spacing:-.03em;margin:0 0 16px;text-wrap:balance}
  .lede{font-size:clamp(16px,2.4vw,18px);max-width:60ch;margin:0}
  .metric{display:flex;align-items:baseline;gap:16px;margin:30px 0 0;padding:20px 22px;background:var(--card);
    border:1px solid var(--line);border-left:4px solid var(--green);border-radius:14px}
  .metric .num{font-size:clamp(34px,8vw,50px);font-weight:800;letter-spacing:-.03em;color:var(--green);
    line-height:1;font-variant-numeric:tabular-nums}
  .metric .cap{font-size:14px;color:var(--muted);max-width:26ch}
  section{margin-top:46px}
  h2{font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);
    margin:0 0 20px;padding-bottom:12px;border-bottom:1px solid var(--line)}
  .freno{display:grid;grid-template-columns:44px 1fr;gap:16px;padding:18px 0;border-bottom:1px solid var(--line)}
  .freno:last-child{border-bottom:0}
  .freno .n{font-size:15px;font-weight:800;color:var(--green);width:34px;height:34px;display:grid;
    place-items:center;border-radius:9px;background:var(--green-soft);font-variant-numeric:tabular-nums}
  .freno h3{margin:2px 0 6px;font-size:17px}
  .freno p{margin:0;color:var(--muted);font-size:15px}
  .win{display:flex;gap:14px;padding:16px 18px;background:var(--card);border:1px solid var(--line);
    border-radius:12px;margin-bottom:12px}
  .win .check{flex:none;width:24px;height:24px;border-radius:50%;background:var(--green-soft);color:var(--green);
    display:grid;place-items:center;font-weight:800}
  .win h3{margin:0;font-size:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .win p{margin:6px 0 0;color:var(--muted);font-size:14px}
  .free{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--green-ink);
    background:var(--green-soft);padding:3px 9px;border-radius:6px}
  .verdict{margin-top:46px;padding:26px clamp(20px,4vw,32px);background:var(--card);border:1px solid var(--line);
    border-radius:18px;position:relative;overflow:hidden}
  .verdict::before{content:"";position:absolute;inset:0 auto 0 0;width:4px;background:linear-gradient(var(--green),var(--brick))}
  .verdict .tag{font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
  .plan{display:inline-flex;align-items:center;gap:9px;font-size:21px;font-weight:800;letter-spacing:-.02em;
    color:var(--green-ink);margin-bottom:12px}
  .plan .badge{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#fff;
    background:var(--green);padding:4px 11px;border-radius:999px}
  .verdict p{margin:0;font-size:15.5px}
  footer{margin-top:44px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
  .meta{margin-top:10px;display:flex;flex-wrap:wrap;gap:6px 18px;font-variant-numeric:tabular-nums}
  .meta b{color:var(--ink);font-weight:600}
</style></head><body>
<div class="wrap">
  <div class="top"><span class="brand"><span class="dot"></span>minka.digital</span>
    <span class="pill">Diagnóstico gratis</span></div>
  <p class="eyebrow">Diagnóstico listo</p>
  <h1>${esc(p.negocio || p.nombre || "Tu negocio")}</h1>
  <p class="lede">${esc(report.resumen)}</p>
  <div class="metric"><span class="num">~${esc(report.horas_semana)} h</span>
    <span class="cap">a la semana que puedes recuperar automatizando</span></div>
  <section><h2>Lo que te está frenando</h2><div class="frenos">${cuellosHTML}</div></section>
  <section><h2>Quick wins — empieza esta semana</h2><div class="wins">${winsHTML}</div></section>
  <div class="verdict"><p class="tag">Nuestro veredicto</p>
    <div class="plan"><span class="badge">Plan</span> ${planLabel}</div>
    <p>${esc(plan.porque)}</p></div>
  <footer>Este diagnóstico fue generado por el <b>Motor Minka</b> con base en lo que nos contaste.
    <div class="meta"><span>Negocio: <b>${esc(p.negocio || "—")}</b></span>
      <span>Contacto: <b>${esc(p.nombre || "—")}</b></span>
      <span>Plan: <b>${planLabel}</b></span>
      <span>Recuperable: <b>~${esc(report.horas_semana)} h/sem</b></span>
      ${fecha ? `<span>Fecha: <b>${fecha}</b></span>` : ""}</div>
  </footer>
</div></body></html>`;
}

module.exports = { renderDiagnosticoHTML, slugify, PLAN_LABEL };
