// lib/diagnostico_html.js — Render del diagnóstico P0 a HTML. Dos salidas del MISMO contenido:
//
//   1) renderDiagnosticoHTML  → documento autocontenido y durable. Se guarda como adjunto
//      (ir.attachment) en la oportunidad de Odoo para que el diagnóstico NO se evapore.
//   2) renderDiagnosticoEmail → el mismo diagnóstico en HTML de CORREO, que es lo que se le manda
//      al prospecto (FASE 2: la página prometía "aquí te mandamos el diagnóstico" y nada lo mandaba).
//
// Por qué DOS renders y no reusar el documento tal cual: el HTML del adjunto usa variables CSS
// (`--paper`), `@media (prefers-color-scheme)`, flex y grid en un `<style>` del head. Gmail borra
// las custom properties, y Outlook de escritorio (motor Word) no soporta flex/grid ni border-radius
// → el diagnóstico llegaría deformado justo al canal donde se juega la promesa. El render de correo
// usa tablas + estilos INLINE (el mínimo común denominador que sí renderiza en todos lados).
// El contenido, el escapado y la paleta son los mismos; sólo cambia el envase.
//
// TODO el contenido dinámico (input del usuario + salida del LLM) se ESCAPA en ambos: el HTML queda
// archivado y se abre después, así que un dato con <script> no debe ejecutarse.

const PLAN_LABEL = {
  "respuesta-ia": "Respuesta IA",
  "funnel-esencial": "Funnel Esencial",
  "sistema-crecimiento": "Sistema de Crecimiento",
};

const SITE_URL = "https://www.minkadigital.com";

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

/* --------------------------- Render para CORREO (FASE 2) --------------------------- */

// Nombre de pila para el saludo. Mismo criterio que scripts/p0_nurture.py:first_name en el repo
// principal: sólo se usa si parece un nombre de verdad. Un "Hola, 3312345678" o un "Hola, ." en el
// primer correo que el prospecto recibe de Minka quema más de lo que suma un saludo personalizado.
function firstName(v) {
  const n = String(v || "").trim().split(/\s+/)[0] || "";
  return /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'’-]{2,20}$/.test(n) ? n : "";
}

// URL del CTA. El `slug` lo produce el LLM → NUNCA se interpola crudo en un href: sólo se usa si
// está en la allowlist de PLAN_LABEL (mismo criterio que el front con PLAN_NAMES). Si el modelo
// inventó un slug, el CTA cae a /activar a secas en vez de generar un enlace basura.
function activarUrl(slug) {
  return PLAN_LABEL[slug] ? `${SITE_URL}/activar?plan=${encodeURIComponent(slug)}` : `${SITE_URL}/activar`;
}

const TG_BOT_USERNAME = process.env.DIAGNOSTICO_TG_BOT || "minka_diagnostico_bot";
const PLAN_CODE = { "respuesta-ia": "R", "funnel-esencial": "F", "sistema-crecimiento": "S" };
// SEGURIDAD/PRIVACIDAD: el payload viaja EXPUESTO — es la URL que el usuario ve y que Telegram
// entrega como el texto literal de su primer mensaje al bot (bot P0 público, sin memoria). Por eso
// NUNCA lleva contacto (nombre, email, whatsapp): solo negocio/giro (que el propio dueño ya conoce
// y no es sensible), el plan recomendado y las horas — lo mínimo para que el bot abra la charla ya
// orientado, sin repetir el descubrimiento completo. Telegram limita el start param a 64 chars de
// [A-Za-z0-9_-]; si no cabe se cae en silencio (el bot sigue funcionando en modo normal).
// Los dueños de negocio escriben su marca con "tipografías" de Instagram — versalitas (ᴘᴜɴᴛᴏ ᴄʀᴇᴍᴀ),
// negritas (𝐌𝐢𝐧𝐤𝐚), cursivas (𝓜𝓲𝓷𝓴𝓪), anchas (ＭＩＮＫＡ). No son fuentes: son caracteres Unicode
// distintos. Sin traducirlos, el saneo los borra TODOS y el negocio queda vacío → sin deep-link.
// Pasó de verdad el 2026-07-30 con "ᴘᴜɴᴛᴏ ᴄʀᴇᴍᴀ ʀᴇꜱᴛᴀᴜʀᴀɴᴛᴇ": el botón no salió.
//
// NFKD resuelve solo, gratis, las negritas/cursivas/anchas/circuladas (tienen descomposición de
// compatibilidad a ASCII). Las VERSALITAS no la tienen —viven en Phonetic Extensions— así que van
// a mano. Es la familia más usada en nombres de negocio locales, no un caso exótico.
const VERSALITAS = {
  "\u1d00":"a","\u0299":"b","\u1d04":"c","\u1d05":"d","\u1d07":"e","\ua730":"f","\u0262":"g",
  "\u029c":"h","\u026a":"i","\u1d0a":"j","\u1d0b":"k","\u029f":"l","\u1d0d":"m","\u0274":"n",
  "\u1d0f":"o","\u1d18":"p","\u01eb":"q","\u0280":"r","\ua731":"s","\u1d1b":"t","\u1d1c":"u",
  "\u1d20":"v","\u1d21":"w","\u028f":"y","\u1d22":"z",
};
// Quita el "formato" de las tipografías de Instagram dejando texto normal, SIN tocar los acentos
// legítimos del español: NFKC compone de vuelta (Café sigue siendo Café, pero 𝐌 pasa a M y Ｍ a M).
// Se usa en la ENTRADA del endpoint, así que el CRM, el correo, el prompt del LLM y el deep-link
// reciben todos texto limpio — antes el nombre entraba a Odoo con versalitas y no era buscable.
function desestilizar(s) {
  return String(s ?? "")
    .replace(/[\u0250-\u02af\u1d00-\u1d7f\ua730\ua731\u01eb]/g, (c) => VERSALITAS[c] || c)
    .normalize("NFKC");
}

function slugParam(s, max) {
  return desestilizar(s)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, max);
}
function telegramUrl(p, report) {
  try {
    // ship-review (Sonnet, docs/ship-review-deeplink-telegram.md): slug desconocido NO cae a "R"
    // — eso le diría a un prospecto de Sistema de Crecimiento que le recomendamos el plan de
    // $699. Mismo criterio que ya usa activarUrl() en este archivo: sin match, sin enlace.
    const plan = PLAN_CODE[report?.plan?.slug];
    if (!plan) return null;
    const horas = Number.isFinite(report?.horas_semana) ? Math.max(0, Math.round(report.horas_semana)) : 0;
    const negocio = slugParam(p?.negocio, 20);
    const giro = slugParam(p?.giro, 14);
    // Un negocio/giro que sanea a vacío (solo puntuación/emoji) rompe el saludo del bot
    // ("...para <negocio> 🙌...") — el regex de charset no lo detecta, hay que exigirlo aparte.
    if (!negocio) return null;
    const payload = `n-${negocio}_g-${giro}_p-${plan}_h-${horas}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(payload)) return null; // no cupo: sin atajo
    return `https://t.me/${TG_BOT_USERNAME}?start=${payload}`;
  } catch {
    return null; // el deep-link es un extra — nunca debe tumbar el diagnóstico
  }
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const C = { paper: "#f5f7f2", card: "#ffffff", ink: "#191d16", muted: "#5f675a", line: "#e2e7dc",
  green: "#12734d", soft: "#e5efe7", greenInk: "#0d5238" };

// Fila de contenido del correo: <tr><td> con el padding lateral estándar.
const row = (inner, pad = "0 32px") => `<tr><td style="padding:${pad};font-family:${FONT}">${inner}</td></tr>`;

function renderDiagnosticoEmail(p = {}, report = {}, opts = {}) {
  const nombre = esc(firstName(p.nombre));
  const negocio = esc(p.negocio || p.nombre || "tu negocio");
  const plan = report.plan || {};
  const planLabel = PLAN_LABEL[plan.slug] || "";
  const horas = esc(report.horas_semana);
  const cuellos = Array.isArray(report.cuellos) ? report.cuellos : [];
  const wins = Array.isArray(report.quickwins) ? report.quickwins : [];
  const fecha = esc(opts.fecha || "");

  // Preheader: el texto de vista previa de la bandeja. Sin él, el cliente de correo muestra el
  // primer texto del cuerpo (el nombre de la marca), que no dice nada y baja la tasa de apertura.
  const preheader = `Tu diagnóstico está listo: ~${horas} horas a la semana que puedes recuperar.`;

  const cuellosHTML = cuellos.map((c, i) => `
        <tr><td style="padding:0 0 14px;font-family:${FONT}">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td width="34" valign="top" style="padding:2px 12px 0 0">
              <div style="width:30px;height:30px;line-height:30px;text-align:center;border-radius:8px;
                background:${C.soft};color:${C.green};font-weight:700;font-size:14px">${i + 1}</div></td>
            <td valign="top" style="font-family:${FONT}">
              <div style="font-size:16px;font-weight:700;color:${C.ink};line-height:1.35">${esc(c && c.titulo)}</div>
              <div style="font-size:14px;color:${C.muted};line-height:1.55;margin-top:4px">${esc(c && c.detalle)}</div>
            </td></tr></table></td></tr>`).join("");

  const winsHTML = wins.map((q) => `
        <tr><td style="padding:0 0 12px;font-family:${FONT}">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
            style="background:${C.card};border:1px solid ${C.line};border-radius:12px"><tr>
            <td style="padding:14px 16px;font-family:${FONT}">
              <div style="font-size:15px;font-weight:700;color:${C.ink};line-height:1.35">${esc(q && q.titulo)}${
                q && q.gratis
                  ? ` <span style="font-size:11px;font-weight:700;text-transform:uppercase;color:${C.greenInk};background:${C.soft};padding:2px 8px;border-radius:6px">gratis</span>`
                  : ""}</div>
              ${q && q.como ? `<div style="font-size:14px;color:${C.muted};line-height:1.55;margin-top:5px">${esc(q.como)}</div>` : ""}
            </td></tr></table></td></tr>`).join("");

  const sectionTitle = (t) => `<div style="font-size:12px;font-weight:700;letter-spacing:.12em;
    text-transform:uppercase;color:${C.muted};padding-bottom:10px;border-bottom:1px solid ${C.line};
    margin-bottom:18px">${t}</div>`;

  // Botón "bulletproof": tabla + bgcolor + padding en el <a>. Outlook ignora el border-radius pero
  // el bloque de color y el enlace siguen funcionando.
  const cta = `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="center" bgcolor="${C.green}" style="border-radius:10px">
            <a href="${activarUrl(plan.slug)}" style="display:inline-block;padding:14px 30px;
              font-family:${FONT};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;
              border-radius:10px">${planLabel ? `Activar ${esc(planLabel)}` : "Ver cómo lo activamos"} &rarr;</a>
          </td></tr></table>`;

  // Segundo CTA, más suave: seguir la conversación con el asistente en Telegram, que ya arranca
  // sabiendo el negocio/giro/plan/horas de este mismo diagnóstico (ver telegramUrl arriba).
  const tgLink = telegramUrl(p, report);
  const tgCta = tgLink ? `
        <p style="margin:14px 0 0;font-size:14px;line-height:1.5">
          <a href="${tgLink}" style="color:${C.greenInk};font-weight:600;text-decoration:none">
            💬 O platícalo con nuestro asistente en Telegram &rarr;</a>
        </p>` : "";

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>Tu diagnóstico — ${negocio}</title></head>
<body style="margin:0;padding:0;background:${C.paper};-webkit-font-smoothing:antialiased">
<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.paper}">
<tr><td align="center" style="padding:24px 12px 36px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
    style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:16px">

    ${row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-family:${FONT};font-size:15px;font-weight:700;color:${C.ink}">minka<span style="color:${C.green}">.</span>digital</td>
      <td align="right" style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:.06em;
        text-transform:uppercase;color:${C.greenInk}">Diagnóstico gratis</td></tr></table>`, "28px 32px 20px")}

    ${row(`
      <div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:${C.green}">Tu diagnóstico está listo</div>
      <h1 style="margin:8px 0 0;font-size:28px;line-height:1.15;color:${C.ink};font-weight:800">${negocio}</h1>
      <p style="margin:14px 0 0;font-size:15px;line-height:1.6;color:${C.ink}">${
        nombre ? `Hola ${nombre}: esto` : "Esto"} es lo que encontramos con lo que nos contaste.</p>
      <p style="margin:10px 0 0;font-size:15px;line-height:1.6;color:${C.muted}">${esc(report.resumen)}</p>`)}

    ${row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="background:${C.soft};border-left:4px solid ${C.green};border-radius:12px"><tr>
      <td style="padding:18px 20px;font-family:${FONT}">
        <div style="font-size:34px;font-weight:800;color:${C.green};line-height:1">~${horas} horas</div>
        <div style="font-size:14px;color:${C.greenInk};margin-top:4px">a la semana que puedes recuperar automatizando</div>
      </td></tr></table>`, "24px 32px 0")}

    ${cuellosHTML ? row(`${sectionTitle("Lo que te está frenando")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${cuellosHTML}</table>`, "32px 32px 0") : ""}

    ${winsHTML ? row(`${sectionTitle("Quick wins — empieza esta semana")}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${winsHTML}</table>`, "28px 32px 0") : ""}

    ${row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
      style="background:${C.paper};border:1px solid ${C.line};border-radius:14px"><tr>
      <td style="padding:22px 24px;font-family:${FONT}">
        <div style="font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${C.muted}">Nuestro veredicto</div>
        <div style="font-size:20px;font-weight:800;color:${C.greenInk};margin:8px 0 10px">${
          planLabel ? esc(planLabel) : "Empieza con los quick wins"}</div>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${C.ink}">${esc(plan.porque)}</p>
        ${cta}
        ${tgCta}
      </td></tr></table>`, "30px 32px 0")}

    ${row(`<div style="border-top:1px solid ${C.line};padding-top:18px;font-size:12px;line-height:1.65;color:${C.muted}">
      <p style="margin:0">Este diagnóstico lo generó el <b style="color:${C.ink}">Motor Minka</b> con base en lo que nos
      contaste${fecha ? ` el ${fecha}` : ""}. Guárdalo: es tuyo, lo ejecutes con nosotros o no.</p>
      <p style="margin:10px 0 0">¿Ya eres cliente o quieres ver el estado de tu asistente?
        <a href="${SITE_URL}/portal" style="color:${C.greenInk}">Entra a tu portal</a>.</p>
      <p style="margin:10px 0 0">Recibes este correo porque pediste tu diagnóstico en
        <a href="${SITE_URL}/diagnostico" style="color:${C.greenInk}">minkadigital.com</a>.
        Puedes responderlo directo — lo lee una persona.
        <a href="${SITE_URL}/privacidad" style="color:${C.muted}">Aviso de privacidad</a>.</p>
    </div>`, "28px 32px 30px")}

  </table>
</td></tr></table>
</body></html>`;
}

module.exports = { renderDiagnosticoHTML, renderDiagnosticoEmail, slugify, activarUrl, telegramUrl, desestilizar, firstName, PLAN_LABEL };
