// lib/postulacion_html.js — las páginas del embudo de postulación, renderizadas en el servidor.
//
// Por qué en el servidor y no como HTML estático en la landing: la forma se re-renderiza con los
// errores Y con lo que la persona ya había escrito. Un redirect con los valores en la query string
// dejaría datos personales en el historial del navegador y en los logs de cualquier proxy; y sin
// JavaScript no hay forma de conservarlos del lado del cliente. Una sola plantilla, un solo lugar
// donde vive la verdad de qué campos existen.
//
// Restricciones de diseño (la mayoría del tráfico llega del navegador dentro de WhatsApp):
//   · una sola columna, móvil primero
//   · inputs a 16px — por debajo de eso iOS hace zoom al enfocar y descuadra la página
//   · cero JavaScript, cero peticiones externas: la página se pinta con lo que trae
//   · autocomplete en todos los campos, para que el llenado sea de dos toques
//
// El CSS es un subconjunto de los tokens de la landing (obsidiana + oro), sin las animaciones de
// scroll: aquí lo que importa es que la forma se llene, no la película.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const money = (n) => "$" + Number(n).toLocaleString("es-MX") + " MXN";

/* ─────────────────────────── Definición de la forma ───────────────────────────
   Una sola fuente de verdad: de aquí salen el render, la validación y el recorte.
   NO hay campo de "categoría del premio": las categorías no están definidas. */
const FIELDS = [
  { name: "nombre", label: "Nombre completo", type: "text", required: true, max: 80,
    autocomplete: "name" },
  { name: "whatsapp", label: "WhatsApp", type: "tel", required: true, max: 24,
    autocomplete: "tel", inputmode: "tel",
    hint: "Con lada. Por aquí te confirmamos tu lugar." },
  { name: "email", label: "Correo electrónico", type: "email", required: true, max: 120,
    autocomplete: "email", inputmode: "email",
    hint: "Aquí llega tu comprobante del apartado." },
  { name: "ciudad", label: "Ciudad y estado", type: "text", required: true, max: 80,
    autocomplete: "address-level2", hint: "Para organizar hospedaje y traslados." },
  { name: "negocio", label: "Tu negocio, marca o estudio", type: "text", required: false, max: 120,
    autocomplete: "organization", hint: "Opcional. Si trabajas por tu cuenta, tu nombre está bien." },
  { name: "anios", label: "Años de trayectoria", type: "select", required: false,
    options: ["", "Menos de 3", "Entre 3 y 5", "Entre 6 y 10", "Más de 10"] },
  { name: "redes", label: "Instagram o TikTok", type: "text", required: false, max: 120,
    autocomplete: "off", hint: "Opcional. Tu @ o el link." },
  { name: "portafolio", label: "Portafolio o sitio web", type: "text", required: false, max: 200,
    autocomplete: "url", hint: "Opcional." },
  { name: "trayectoria", label: "Cuéntanos tu trayectoria", type: "textarea", required: true,
    max: 1200, rows: 6,
    hint: "Qué has construido, qué te distingue, qué te gustaría que se reconociera. " +
          "Escríbelo como lo contarías en persona — no buscamos un currículum." },
];

/* ──────────────────────────────── Cascarón ──────────────────────────────── */

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
 --obsidian:#0a0806;--obsidian-2:#120d09;--ink:#f4ece0;--ink-soft:#c3b5a2;--ink-faint:#8a7c6a;
 --gold:#c9a24a;--gold-lit:#f0d488;--line:rgba(201,162,74,.18);--err:#e8a49c;
 --serif:"Didot","Bodoni MT","Playfair Display",Georgia,"Times New Roman",serif;
 --sans:"Optima","Avenir Next","Futura","Century Gothic","Segoe UI",system-ui,sans-serif;
 --mono:"SFMono-Regular","Consolas",monospace}
html{background:var(--obsidian);-webkit-text-size-adjust:100%}
body{background:var(--obsidian);color:var(--ink);font-family:var(--sans);font-size:17px;
 line-height:1.65;-webkit-font-smoothing:antialiased}
.page{max-width:660px;margin:0 auto;padding:0 22px 90px}
h1,h2,h3{font-family:var(--serif);font-weight:400;line-height:1.08;text-wrap:balance}
a{color:var(--gold-lit)}
.eyebrow{font-family:var(--mono);font-size:11.5px;letter-spacing:.28em;text-transform:uppercase;
 color:var(--gold)}
.top{display:flex;justify-content:space-between;align-items:center;gap:16px;
 padding:22px 0;border-bottom:1px solid var(--line);margin-bottom:44px}
.top a{font-family:var(--mono);font-size:11px;letter-spacing:.2em;text-transform:uppercase;
 color:var(--ink-soft);text-decoration:none}
.top a:hover{color:var(--gold-lit)}
h1{font-size:clamp(2rem,8vw,3.1rem);margin:14px 0 0}
.lead{color:var(--ink-soft);margin-top:18px}
em{font-style:italic;color:var(--gold-lit)}

/* Nota destacada — el encuadre honesto del apartado */
.note{border-left:2px solid var(--gold);background:var(--obsidian-2);
 padding:20px 22px;margin:34px 0;border-radius:0 2px 2px 0}
.note p+p{margin-top:12px}
.note b{color:var(--gold-lit);font-weight:400}
.note .small{font-size:.92rem;color:var(--ink-faint)}

/* Formulario */
form{margin-top:40px}
fieldset{border:0;margin:0 0 8px}
legend{font-family:var(--mono);font-size:11.5px;letter-spacing:.24em;text-transform:uppercase;
 color:var(--gold);padding:0 0 6px}
.f{margin-bottom:26px}
.f>label{display:block;font-family:var(--mono);font-size:11.5px;letter-spacing:.18em;
 text-transform:uppercase;color:var(--ink-soft);margin-bottom:9px}
.f>label .req{color:var(--gold)}
.hint{display:block;font-size:.92rem;color:var(--ink-faint);margin:-3px 0 10px;font-style:italic}
input[type=text],input[type=email],input[type=tel],textarea,select{
 width:100%;font-family:var(--sans);font-size:16px;color:var(--ink);
 background:var(--obsidian-2);border:1px solid var(--line);border-radius:2px;
 padding:14px 15px;line-height:1.5}
input,textarea,select{-webkit-appearance:none;appearance:none}
textarea{resize:vertical;min-height:150px}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23c9a24a' stroke-width='1.4' fill='none'/%3E%3C/svg%3E");
 background-repeat:no-repeat;background-position:right 16px center;padding-right:44px}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--gold);
 box-shadow:0 0 0 3px rgba(201,162,74,.14)}
input::placeholder,textarea::placeholder{color:#6b5f51}
.f.bad input,.f.bad textarea,.f.bad select{border-color:var(--err)}
.err{display:block;color:var(--err);font-size:.9rem;margin-top:8px}

/* Casillas */
.check{display:flex;gap:13px;align-items:flex-start;margin-bottom:24px}
.check input[type=checkbox]{-webkit-appearance:auto;appearance:auto;accent-color:var(--gold);
 width:20px;height:20px;flex:0 0 auto;margin-top:2px}
.check label{font-size:.97rem;color:var(--ink-soft);line-height:1.5}
.check.bad label{color:var(--err)}

/* Aviso de errores arriba */
.alert{border:1px solid var(--err);background:rgba(232,164,156,.07);padding:18px 20px;
 border-radius:2px;margin-bottom:34px}
.alert b{color:var(--err);font-weight:400}
.alert ul{margin:10px 0 0 18px;font-size:.95rem}
.alert a{color:var(--err)}
.ok-box{border:1px solid rgba(201,162,74,.45);background:rgba(201,162,74,.07);padding:18px 20px;
 border-radius:2px;margin-bottom:30px;font-size:.97rem}

/* Botones */
.btn{display:block;width:100%;text-align:center;font-family:var(--mono);font-size:13px;
 letter-spacing:.22em;text-transform:uppercase;color:#120d09;background:var(--gold);
 border:1px solid var(--gold);padding:20px 26px;border-radius:2px;cursor:pointer;
 text-decoration:none;transition:background .3s,color .3s}
.btn:hover{background:var(--gold-lit);border-color:var(--gold-lit)}
.btn.ghost{color:var(--gold-lit);background:transparent}
.btn.ghost:hover{background:rgba(201,162,74,.12);color:var(--gold-lit)}
.btn+.btn{margin-top:14px}
.after{font-size:.88rem;color:var(--ink-faint);text-align:center;margin-top:16px}

/* Bloques de la pantalla de gracias */
.card{border:1px solid var(--line);background:var(--obsidian-2);padding:26px 24px;
 border-radius:2px;margin:30px 0}
.card h2{font-size:1.6rem;color:var(--ink)}
.card p{color:var(--ink-soft);font-size:.98rem;margin-top:12px}
.price{font-family:var(--serif);font-size:2.6rem;color:var(--gold-lit);margin:14px 0 4px}
.ph{color:var(--gold);border-bottom:1px dashed rgba(201,162,74,.5)}
.file{display:block;width:100%;font-size:16px;color:var(--ink-soft);background:var(--obsidian);
 border:1px dashed var(--line);border-radius:2px;padding:16px 15px}
.file::file-selector-button{font-family:var(--mono);font-size:11px;letter-spacing:.16em;
 text-transform:uppercase;color:var(--gold-lit);background:transparent;
 border:1px solid var(--gold);border-radius:2px;padding:10px 14px;margin-right:14px;cursor:pointer}
hr{border:0;border-top:1px solid var(--line);margin:40px 0}
footer{border-top:1px solid var(--line);margin-top:54px;padding-top:26px;text-align:center;
 color:var(--ink-faint);font-family:var(--mono);font-size:10.5px;letter-spacing:.18em;
 text-transform:uppercase;line-height:2}
footer a{color:var(--gold);text-decoration:none}
@media (max-width:420px){.page{padding-left:18px;padding-right:18px}h1{font-size:1.85rem}}
`;

function shell({ title, description, body, robots = "noindex, nofollow" }) {
  return `<!doctype html>
<html lang="es-MX">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="${esc(robots)}">
<meta name="theme-color" content="#0a0806">
<style>${CSS}</style>
</head>
<body>
<div class="page">
${body}
</div>
</body>
</html>`;
}

function topBar(sub) {
  return `<div class="top">
  <span class="eyebrow">${esc(sub)}</span>
  <a href="/">&larr; Volver</a>
</div>`;
}

function footer(cfg) {
  return `<footer>
  <p>Carreras de Éxito &middot; Íconos de la Belleza &middot; IV</p>
  <p><a href="/privacidad">Aviso de privacidad</a> &middot;
     <a href="https://wa.me/${esc(cfg.whatsapp)}" target="_blank" rel="noopener">WhatsApp</a></p>
</footer>`;
}

/* ──────────────────────────────── La forma ──────────────────────────────── */

function renderField(f, values, errors) {
  const id = "f-" + f.name;
  const v = values[f.name] ?? "";
  const err = errors[f.name];
  const describedBy = [f.hint ? `${id}-h` : null, err ? `${id}-e` : null].filter(Boolean).join(" ");
  const common = [
    `id="${id}"`, `name="${f.name}"`,
    f.required ? "required" : "",
    f.max ? `maxlength="${f.max}"` : "",
    f.autocomplete ? `autocomplete="${f.autocomplete}"` : "",
    f.inputmode ? `inputmode="${f.inputmode}"` : "",
    err ? 'aria-invalid="true"' : "",
    describedBy ? `aria-describedby="${describedBy}"` : "",
  ].filter(Boolean).join(" ");

  let control;
  if (f.type === "textarea") {
    control = `<textarea ${common} rows="${f.rows || 5}">${esc(v)}</textarea>`;
  } else if (f.type === "select") {
    const opts = f.options.map((o) =>
      `<option value="${esc(o)}"${o === v ? " selected" : ""}>${o ? esc(o) : "Prefiero no decirlo"}</option>`
    ).join("");
    control = `<select ${common}>${opts}</select>`;
  } else {
    control = `<input type="${f.type}" ${common} value="${esc(v)}">`;
  }

  return `<div class="f${err ? " bad" : ""}">
  <label for="${id}">${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</label>
  ${f.hint ? `<span class="hint" id="${id}-h">${esc(f.hint)}</span>` : ""}
  ${control}
  ${err ? `<span class="err" id="${id}-e">${esc(err)}</span>` : ""}
</div>`;
}

function formPage({ values = {}, errors = {}, cfg }) {
  const list = Object.keys(errors);
  const alert = list.length ? `<div class="alert" role="alert">
  <p><b>Faltan un par de cosas.</b> Revisa lo marcado abajo &mdash; no perdiste nada de lo que ya escribiste.</p>
  <ul>${list.map((k) => {
    const f = FIELDS.find((x) => x.name === k);
    return `<li><a href="#f-${esc(k)}">${esc(f ? f.label : k)}</a></li>`;
  }).join("")}</ul>
</div>` : "";

  const body = `${topBar("Postulación · Cuarta edición")}
<h1>Tu <em>postulación</em></h1>
<p class="lead">Cuéntanos tu trayectoria. Son <b>${cfg.lugares} lugares</b> y se apartan en el orden
en que llegan las postulaciones; en cuanto recibamos la tuya te escribimos por WhatsApp
${cfg.tiempoRespuesta ? `en ${esc(cfg.tiempoRespuesta)}` : ""}.</p>

<div class="note">
  <p><b>Cómo funciona el apartado.</b> Al terminar esta forma podrás apartar tu lugar con
  <b>${money(cfg.apartadoMxn)}</b>. Ese monto <b>se abona al precio de tu pase</b> cuando confirmes tu
  asistencia.</p>
  <p class="small">Si decides no asistir, el apartado no se reembolsa &mdash; es lo que mantiene tu
  lugar fuera de la lista mientras te decides. Registrarte aquí no te obliga a pagar nada: si
  prefieres, apartas después o lo arreglamos por WhatsApp.</p>
</div>

${alert}

<form method="post" action="/postulacion" novalidate>
  <fieldset>
    <legend>Tus datos</legend>
    ${FIELDS.slice(0, 5).map((f) => renderField(f, values, errors)).join("\n")}
  </fieldset>
  <fieldset>
    <legend>Tu trayectoria</legend>
    ${FIELDS.slice(5).map((f) => renderField(f, values, errors)).join("\n")}
  </fieldset>
  <fieldset>
    <legend>Antes de enviar</legend>
    <div class="check">
      <input type="checkbox" id="f-tequila" name="tequila" value="si"${values.tequila ? " checked" : ""}>
      <label for="f-tequila">Me interesa el extra del domingo &mdash; el viaje a Tequila
        (${money(cfg.extraTequilaMxn)} por persona, se paga aparte).</label>
    </div>
    <div class="check${errors.privacidad ? " bad" : ""}">
      <input type="checkbox" id="f-privacidad" name="privacidad" value="si" required
        ${values.privacidad ? " checked" : ""}${errors.privacidad ? ' aria-invalid="true"' : ""}>
      <label for="f-privacidad">He leído el <a href="/privacidad" target="_blank" rel="noopener">aviso de
        privacidad</a> y acepto que mis datos se usen para atender mi postulación a este evento.
        <span class="req">*</span></label>
    </div>
  </fieldset>

  <div style="position:absolute;left:-9999px" aria-hidden="true">
    <label for="f-web">No llenes esto</label>
    <input type="text" id="f-web" name="website_hp" tabindex="-1" autocomplete="off">
  </div>

  <button class="btn" type="submit">Enviar mi postulación</button>
  <p class="after">Después de enviar podrás apartar tu lugar y, si quieres, adjuntar reconocimientos.</p>
</form>

${footer(cfg)}`;

  return shell({
    title: "Postúlate · Íconos de la Belleza — Carreras de Éxito IV",
    description: "Cuéntanos tu trayectoria y aparta tu lugar en la cuarta edición.",
    body,
  });
}

/* ─────────────────────────── Pantalla de gracias ─────────────────────────── */

// Avisos por código corto en la query string. Nunca datos personales: sólo un código y, cuando
// aplica, cuántos archivos se recibieron.
function flashFor(q) {
  const n = Math.max(0, Math.min(99, parseInt(q.n, 10) || 0));
  const M = {
    "d:ok": `Recibimos ${n} ${n === 1 ? "documento" : "documentos"}. Quedaron en tu expediente.`,
    "d:big": "Ese archivo pesa demasiado para subirlo aquí. Mándalo por WhatsApp y lo agregamos nosotros.",
    "d:many": "Son demasiados archivos de una vez. Sube unos cuantos y repite, o mándalos por WhatsApp.",
    "d:tipo": "Ese tipo de archivo no lo aceptamos aquí. Manda imágenes o PDF, o escríbenos por WhatsApp.",
    "d:err": "No pudimos guardar los documentos. Tu postulación está a salvo — mándalos por WhatsApp.",
    "p:ok": "¡Listo! Recibimos tu apartado. Te llega el comprobante por correo.",
    "p:pend": "Tu pago se está procesando. En cuanto se confirme te avisamos por WhatsApp.",
    "p:no": "El pago no se completó. Tu postulación sigue guardada — puedes intentarlo otra vez.",
  };
  const key = q.d ? `d:${q.d}` : q.p ? `p:${q.p}` : "";
  return M[key] || "";
}

function graciasPage({ token, cfg, query = {} }) {
  const flash = flashFor(query);
  const paid = query.p === "ok";
  const waTexto = encodeURIComponent(
    "¡Hola! Acabo de enviar mi postulación para Íconos de la Belleza — Carreras de Éxito. " +
    "Quiero apartar mi lugar por transferencia.");
  const waDocs = encodeURIComponent(
    "¡Hola! Acabo de enviar mi postulación para Íconos de la Belleza. Les mando mis reconocimientos.");

  // Sin token no hay lead al que ligar un pago ni un documento (el CRM falló al guardar). No se
  // ofrece cobrar: cobrar algo que no podemos atribuir a nadie es peor que no cobrarlo. La
  // postulación no se pierde — viajó por Telegram — así que se encamina todo a WhatsApp.
  if (!token) {
    const body0 = `${topBar("Postulación recibida")}
<h1>Recibimos tu <em>postulación</em>.</h1>
<p class="lead">Ya la tenemos. Te escribimos por WhatsApp
${cfg.tiempoRespuesta ? `en ${esc(cfg.tiempoRespuesta)}` : "en cuanto la revisemos"} para apartar
tu lugar y resolver lo que haga falta.</p>
<div class="card">
  <span class="eyebrow">Siguiente paso</span>
  <h2>Apartamos tu lugar por WhatsApp.</h2>
  <p>Ahí te pasamos el enlace de pago de los ${money(cfg.apartadoMxn)} del apartado y puedes
  mandarnos tus reconocimientos si tienes.</p>
  <a class="btn" style="margin-top:20px" href="https://wa.me/${esc(cfg.whatsapp)}?text=${waTexto}"
     target="_blank" rel="noopener">Escribir por WhatsApp</a>
</div>
${footer(cfg)}`;
    return shell({
      title: "Postulación recibida · Íconos de la Belleza",
      description: "Recibimos tu postulación.",
      body: body0,
    });
  }

  const apartado = paid ? `<div class="card">
  <span class="eyebrow">Tu lugar</span>
  <h2>Lugar apartado.</h2>
  <p>Ya está. Te escribimos por WhatsApp con los detalles del pase, la fecha y la sede en cuanto
  estén confirmados. Los ${money(cfg.apartadoMxn)} se abonan al precio de tu pase.</p>
</div>` : `<div class="card">
  <span class="eyebrow">Aparta tu lugar</span>
  <h2>Son ${cfg.lugares} lugares.</h2>
  <div class="price">${money(cfg.apartadoMxn)}</div>
  <p>Se abonan al precio de tu pase. Si decides no asistir, no se reembolsan.
  ${cfg.precioPase ? `El pase completo es de ${esc(cfg.precioPase)}.`
    : '<span class="ph">El precio del pase se confirma en breve.</span>'}</p>
  <form method="post" action="/postulacion/pago" style="margin-top:22px">
    <input type="hidden" name="t" value="${esc(token)}">
    <button class="btn" type="submit">Apartar mi lugar &mdash; ${money(cfg.apartadoMxn)}</button>
  </form>
  <p class="after">Pago seguro con Stripe. El cargo aparece en tu estado de cuenta a nombre de
  <b>Minka Digital</b>, la agencia que opera el registro.</p>
  <a class="btn ghost" style="margin-top:16px"
     href="https://wa.me/${esc(cfg.whatsapp)}?text=${waTexto}" target="_blank" rel="noopener">
     Prefiero pagar por transferencia</a>
</div>`;

  const body = `${topBar("Postulación recibida")}
<h1>Recibimos tu <em>postulación</em>.</h1>
<p class="lead">Ya estás en la lista. Te escribimos por WhatsApp
${cfg.tiempoRespuesta ? `en ${esc(cfg.tiempoRespuesta)}` : "en cuanto la revisemos"}.
${cfg.fechaSede ? `El evento es ${esc(cfg.fechaSede)}.`
  : '<span class="ph">Fecha y sede por confirmar.</span>'}</p>

${flash ? `<div class="ok-box">${esc(flash)}</div>` : ""}

${apartado}

<hr>

<div class="card">
  <span class="eyebrow">Opcional</span>
  <h2>¿Tienes reconocimientos?</h2>
  <p>Diplomas, certificados, cartas de recomendación, premios, fotos de tu trabajo. <b>Manda lo que
  tengas</b> &mdash; no necesita ser un CV formal ni estar bonito. Si no tienes nada a la mano, no
  pasa nada: tu postulación ya está completa.</p>
  <form method="post" action="/postulacion/documentos" enctype="multipart/form-data" style="margin-top:20px">
    <input type="hidden" name="t" value="${esc(token)}">
    <div class="f">
      <label for="f-docs">Tus archivos</label>
      <span class="hint">Imágenes o PDF, hasta 5 archivos de 3 MB cada uno. No aceptamos video
      &mdash; si tienes uno, mándalo por WhatsApp.</span>
      <input class="file" type="file" id="f-docs" name="documentos" multiple
             accept="image/jpeg,image/png,image/webp,image/heic,application/pdf">
    </div>
    <button class="btn ghost" type="submit">Adjuntar a mi expediente</button>
  </form>
  <a class="btn ghost" style="margin-top:14px"
     href="https://wa.me/${esc(cfg.whatsapp)}?text=${waDocs}" target="_blank" rel="noopener">
     Mejor los mando por WhatsApp</a>
</div>

${footer(cfg)}`;

  return shell({
    title: "Postulación recibida · Íconos de la Belleza",
    description: "Recibimos tu postulación. Aparta tu lugar y adjunta tus reconocimientos.",
    body,
  });
}

// Página de error genérica (token vencido/inválido, fallos del CRM). Nunca revela por qué falló
// más allá de un token diagnóstico corto, y siempre deja una salida: WhatsApp.
function avisoPage({ cfg, titulo, mensaje, codigo = "" }) {
  const body = `${topBar("Postulación")}
<h1>${esc(titulo)}</h1>
<p class="lead">${esc(mensaje)}</p>
<div class="card">
  <p>Escríbenos por WhatsApp y lo resolvemos en un momento.</p>
  <a class="btn" style="margin-top:18px" href="https://wa.me/${esc(cfg.whatsapp)}"
     target="_blank" rel="noopener">Escribir por WhatsApp</a>
  <a class="btn ghost" style="margin-top:14px" href="/postulacion">Volver a la postulación</a>
</div>
${codigo ? `<p class="after">Código: ${esc(codigo)}</p>` : ""}
${footer(cfg)}`;
  return shell({ title: `${titulo} · Íconos de la Belleza`, description: mensaje, body });
}

// Cabeceras de seguridad de las páginas del embudo. La política es la que le corresponde a una
// página sin JavaScript, y por eso puede ser tan estricta: `default-src 'none'` bloquea TODO por
// defecto —incluidos los scripts— y se abre sólo lo que estas páginas usan de verdad: el <style>
// en línea del cascarón, la flecha del <select> (una imagen data:) y que los formularios apunten a
// nosotros mismos o a Stripe, que es a donde lleva el 303 del botón de pago.
const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "form-action 'self' https://checkout.stripe.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

function setSecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

module.exports = { formPage, graciasPage, avisoPage, shell, esc, money, FIELDS, CSS, CSP, setSecurityHeaders };
