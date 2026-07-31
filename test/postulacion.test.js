// test/postulacion.test.js — Embudo de postulación: validación, render, documentos y apartado.
// Corre: `node test/postulacion.test.js`. Exit 1 si falla algo. Sin deps.
//
//  A: validación (el email es obligatorio porque el dedup del CRM es email-only)
//  B: la re-renderización conserva lo escrito y escapa el HTML
//  C: la pantalla de gracias sin token no ofrece cobrar
//  D: los documentos se aceptan por firma real del archivo, no por lo que declare el navegador
//  E: encodeForm arma la notación de corchetes que espera Stripe
//  F: confirm() sólo cree lo que Stripe le confirma (nunca al navegador ni al webhook)
//  G: confirm() es idempotente — dos caminos, un solo registro
//  H: el webhook es fail-closed sin secreto configurado

process.env.ODOO_URL_JUANELO = "https://juanelo.crm.minkadigital.com";
process.env.ODOO_DB_JUANELO = "juanelo";
process.env.ODOO_USER_JUANELO = "j@x.com";
process.env.ODOO_API_KEY_JUANELO = "key-juanelo";
process.env.ODOO_WAKE_RETRIES = "0";
process.env.EVENTO_CRM_TENANT = "juanelo";
process.env.EVENTO_APARTADO_MXN = "100";
process.env.POSTULACION_TOKEN_SECRET = "secreto-de-prueba";
process.env.STRIPE_SECRET_KEY = "sk_test_ejemplo";
delete process.env.CRM_DRIVER;
delete process.env.TELEGRAM_BOT_TOKEN;

const { __validate: validate, __readValues: readValues } = require("../api/postulacion.js");
const { __sniff: sniff } = require("../api/postulacion-documentos.js");
const { __secretOk: secretOk } = require("../api/stripe-webhook.js");
const { formPage, graciasPage } = require("../lib/postulacion_html");
const { config } = require("../lib/evento");
const { confirm } = require("../lib/apartado");
const stripe = require("../lib/stripe");
const crm = require("../lib/crm");

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log(" FAIL  " + label); }
}

const cfg = config();
const BASE = {
  nombre: "Rosa Martínez", whatsapp: "+52 33 1234 5678", email: "rosa@ejemplo.mx",
  ciudad: "Guadalajara, Jalisco",
  trayectoria: "Llevo doce años con mi estudio de belleza y he formado a más de cuarenta estilistas.",
  privacidad: true,
};

/* ─────────────────────────────── A: validación ─────────────────────────────── */
{
  check(Object.keys(validate(BASE)).length === 0, "A: una postulación completa pasa");

  for (const campo of ["nombre", "whatsapp", "email", "ciudad", "trayectoria"]) {
    const v = { ...BASE, [campo]: "" };
    check(Boolean(validate(v)[campo]), `A: ${campo} es obligatorio`);
  }
  check(Boolean(validate({ ...BASE, privacidad: false }).privacidad),
    "A: sin aceptar el aviso de privacidad no se envía (LFPDPPP)");

  for (const mal of ["rosa", "rosa@", "@ejemplo.mx", "rosa ejemplo.mx", "rosa@ejemplo"]) {
    check(Boolean(validate({ ...BASE, email: mal }).email), `A: rechaza el email ${JSON.stringify(mal)}`);
  }
  check(!validate({ ...BASE, email: "a.b+c@sub.dominio.mx" }).email, "A: acepta un email con + y subdominio");
  check(Boolean(validate({ ...BASE, whatsapp: "33 12" }).whatsapp), "A: rechaza un teléfono demasiado corto");
  check(!validate({ ...BASE, whatsapp: "3312345678" }).whatsapp, "A: acepta 10 dígitos sin lada internacional");
  check(Boolean(validate({ ...BASE, trayectoria: "soy buena" }).trayectoria),
    "A: pide algo más que una frase suelta de trayectoria");

  const v = readValues({ nombre: "  Ana  ", email: "  ANA@X.COM ", trayectoria: "y".repeat(5000),
    tequila: "si", privacidad: "si" });
  check(v.nombre === "Ana", "A: recorta espacios");
  check(v.email === "ana@x.com", "A: normaliza el email a minúsculas (el dedup es por email)");
  check(v.trayectoria.length === 1200, "A: trunca los campos largos al máximo declarado");
  check(v.tequila === true && v.privacidad === true, "A: las casillas se leen como booleanos");
}

/* ──────────────────── B: re-render con errores y escapado ──────────────────── */
{
  const xss = '"><script>alert(1)</script>';
  const html = formPage({ values: { ...BASE, nombre: xss }, errors: { email: "Revisa el correo." }, cfg });
  check(!html.includes("<script>alert(1)"), "B: el valor hostil NO se inyecta como HTML");
  check(html.includes("&lt;script&gt;"), "B: el valor hostil se muestra escapado");
  check(html.includes("Revisa el correo."), "B: el mensaje de error se pinta");
  check(html.includes('value="Guadalajara, Jalisco"'), "B: conserva lo que ya se había escrito");
  check(html.includes(BASE.trayectoria), "B: conserva el texto largo del textarea");
  check(html.includes('aria-invalid="true"'), "B: marca el campo inválido para lectores de pantalla");
  check(/font-size:16px/.test(html), "B: los inputs van a 16px (si no, iOS hace zoom al enfocar)");
  check(!/<script/i.test(html), "B: la página no lleva nada de JavaScript");
  check(html.includes('href="/privacidad"'), "B: enlaza el aviso en el punto de recolección");
  check(Buffer.byteLength(html) < 60 * 1024, "B: la página pesa menos de 60 KB");
}

/* ─────────────── C: la pantalla de gracias sin lead no ofrece cobrar ─────────────── */
{
  const sinToken = graciasPage({ token: "", cfg, query: {} });
  check(!sinToken.includes("/postulacion/pago"), "C: sin lead al que ligar el pago, no se ofrece cobrar");
  check(sinToken.includes("wa.me"), "C: se encamina a WhatsApp");
  const conToken = graciasPage({ token: "1.5.999.x", cfg, query: {} });
  check(conToken.includes("/postulacion/pago"), "C: con token sí se ofrece el apartado");
  check(conToken.includes("Minka Digital"), "C: avisa que el cargo aparece a nombre de Minka");
  check(/no se reembolsan|no es reembolsable/i.test(conToken), "C: dice que no es reembolsable");
  check(/se abonan al precio de tu pase/i.test(conToken), "C: dice que se abona al pase");
  const pagado = graciasPage({ token: "1.5.999.x", cfg, query: { p: "ok" } });
  check(!pagado.includes("/postulacion/pago"), "C: ya pagado, no se vuelve a ofrecer el cobro");

  // Sin pasarela configurada no se pinta un botón que llevaría a una página de error.
  const sinPasarela = graciasPage({ token: "1.5.999.x", cfg: { ...cfg, pagoEnLinea: false }, query: {} });
  check(!sinPasarela.includes("/postulacion/pago"), "C: sin Stripe no se ofrece el botón de pago");
  check(sinPasarela.includes("Apartar por WhatsApp"), "C: sin Stripe se aparta por WhatsApp");
  check(sinPasarela.includes("$100 MXN"), "C: sin Stripe se sigue diciendo el monto del apartado");
}

/* ──────────────────── D: documentos por firma real, no declarada ──────────────────── */
{
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pdf = Buffer.from("%PDF-1.7\n...");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ — un ejecutable de Windows
  check(sniff(jpg).ext === "jpg", "D: reconoce JPEG");
  check(sniff(png).ext === "png", "D: reconoce PNG");
  check(sniff(pdf).ext === "pdf", "D: reconoce PDF");
  check(sniff(webp).ext === "webp", "D: reconoce WEBP (RIFF….WEBP)");
  check(sniff(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("AVI ")])) === null,
    "D: un RIFF que no es WEBP se rechaza");
  check(sniff(exe) === null, "D: un ejecutable renombrado a .jpg NO pasa");
  check(sniff(Buffer.from("<?php echo 1; ?>")) === null, "D: un script no pasa");
  check(sniff(Buffer.alloc(2)) === null, "D: un archivo demasiado corto no pasa");
}

/* ─────────────────── E: codificación de formularios de Stripe ─────────────────── */
{
  const q = stripe.encodeForm({
    mode: "payment",
    metadata: { leadId: "42", tenant: "juanelo" },
    line_items: [{ quantity: 1, price_data: { currency: "mxn", unit_amount: 10000 } }],
    vacio: "", nulo: null,
  }).join("&");
  check(q.includes("mode=payment"), "E: campo plano");
  check(q.includes("metadata%5BleadId%5D=42"), "E: objeto anidado → metadata[leadId]");
  check(q.includes("line_items%5B0%5D%5Bquantity%5D=1"), "E: arreglo → line_items[0][quantity]");
  check(q.includes("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=10000"), "E: anidado profundo");
  check(!q.includes("vacio") && !q.includes("nulo"), "E: omite vacíos y nulos");
  check(stripe.isSessionId("cs_test_a1B2c3D4e5") && stripe.isSessionId("cs_live_XyZ12345"),
    "E: acepta ids de sesión válidos");
  for (const mal of ["", "cs_", "pi_test_123", "cs_test_a", "../../etc", "cs_test_<script>"]) {
    check(!stripe.isSessionId(mal), `E: rechaza el id ${JSON.stringify(mal)}`);
  }
}

/* ───────────────────────── F y G: confirmación del apartado ───────────────────────── */

// Router de fetch: enruta a Stripe o a Odoo según la URL. `mensajesPrevios` simula que la nota del
// cobro ya estaba escrita (el otro camino llegó primero).
function mockRed({ session, mensajesPrevios = [] } = {}) {
  const st = { stripe: [], odoo: [], posts: [], tags: [] };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith("https://api.stripe.com/")) {
      st.stripe.push(u);
      return { ok: Boolean(session), status: session ? 200 : 404,
        json: async () => (session || { error: { code: "resource_missing" } }) };
    }
    if (u.startsWith("https://api.telegram.org/")) return { ok: true, status: 200, json: async () => ({}) };
    const p = JSON.parse(opts.body).params;
    if (p.service === "common") return { status: 200, json: async () => ({ result: 2 }) };
    const [db, uid, key, model, method, args, kwargs] = p.args;
    st.odoo.push({ db, model, method, args, kwargs });
    if (model === "mail.message" && method === "search") {
      return { status: 200, json: async () => ({ result: mensajesPrevios }) };
    }
    if (method === "search") return { status: 200, json: async () => ({ result: [] }) };
    if (model === "crm.lead" && method === "message_post") { st.posts.push(kwargs.body); }
    if (model === "crm.lead" && method === "write") { st.tags.push(args[1]); }
    return { status: 200, json: async () => ({ result: 501 }) };
  };
  return st;
}

const sesion = (over = {}) => ({
  id: "cs_test_abcdefgh12345", livemode: false, payment_status: "paid",
  amount_total: 10000, currency: "mxn",
  metadata: { leadId: "42", tenant: "juanelo" },
  customer_details: { email: "rosa@ejemplo.mx" }, ...over,
});

async function main() {
  // F1: un id con forma inválida no llega ni a llamar a Stripe
  {
    const st = mockRed({ session: sesion() });
    crm.__resetCaches();
    const r = await confirm("no-es-una-sesion", cfg);
    check(r.ok === false && r.reason === "bad-session-id", "F: id mal formado se rechaza");
    check(st.stripe.length === 0, "F: no se llama a Stripe con un id inventado");
  }

  // F2: Stripe dice que NO está pagado → no se escribe nada en el CRM
  {
    const st = mockRed({ session: sesion({ payment_status: "unpaid" }) });
    crm.__resetCaches();
    const r = await confirm("cs_test_abcdefgh12345", cfg);
    check(r.ok === true && r.paid === false, "F: sesión sin pagar → paid:false");
    check(st.posts.length === 0, "F: no se anota un pago que Stripe no confirma");
  }

  // F3: modo de prueba contra llave real (o al revés) → se rechaza
  {
    mockRed({ session: sesion({ livemode: true }) });
    crm.__resetCaches();
    const r = await confirm("cs_test_abcdefgh12345", cfg);
    check(r.ok === false && r.reason === "livemode-mismatch", "F: livemode que no corresponde se rechaza");
  }

  // F4: una sesión de OTRO cliente no puede escribir en esta base
  {
    const st = mockRed({ session: sesion({ metadata: { leadId: "42", tenant: "otro-cliente" } }) });
    crm.__resetCaches();
    const r = await confirm("cs_test_abcdefgh12345", cfg);
    check(r.ok === false && r.reason === "tenant-mismatch", "F: tenant que no corresponde se rechaza");
    check(st.posts.length === 0, "F: no se escribe en la base de este cliente");
  }

  // F5: sin leadId en la metadata no hay a quién atribuirlo
  {
    mockRed({ session: sesion({ metadata: { tenant: "juanelo" } }) });
    crm.__resetCaches();
    const r = await confirm("cs_test_abcdefgh12345", cfg);
    check(r.ok === false && r.reason === "no-lead", "F: sin leadId no se atribuye el pago a nadie");
  }

  // F6: camino feliz
  {
    const st = mockRed({ session: sesion() });
    crm.__resetCaches();
    const r = await confirm("cs_test_abcdefgh12345", cfg);
    check(r.ok === true && r.paid === true && r.leadId === 42, "F: pago confirmado y atribuido al lead 42");
    check(st.odoo.every((o) => o.db === "juanelo"), "F: todo se escribe en la base del cliente");
    check(st.posts.length === 1 && /APARTADO PAGADO/.test(st.posts[0]), "F: deja la nota del cobro");
    check(st.posts[0].includes("cs_test_abcdefgh12345"), "F: la nota referencia la sesión de Stripe");
    check(st.posts[0].includes("$100 MXN"), "F: la nota lleva el monto que Stripe cobró");
    check(st.tags.length === 1, "F: etiqueta el lead como apartado-pagado");
  }

  // F7: el monto que se registra es el que Stripe cobró, no el que dice la configuración hoy
  {
    const st = mockRed({ session: sesion({ amount_total: 25000 }) });
    crm.__resetCaches();
    await confirm("cs_test_abcdefgh12345", cfg);
    check(st.posts[0].includes("$250 MXN"), "F: registra lo realmente cobrado ($250)");
    check(st.posts[0].includes("configurado hoy: $100 MXN"), "F: marca la diferencia con lo configurado");
  }

  // G: idempotencia — el webhook y el retorno del navegador no dejan dos registros
  {
    const st = mockRed({ session: sesion(), mensajesPrevios: [999] });
    crm.__resetCaches();
    const r = await confirm("cs_test_abcdefgh12345", cfg);
    check(r.ok === true && r.paid === true && r.deduped === true, "G: la segunda confirmación se deduplica");
    check(st.posts.length === 0, "G: no se escribe una segunda nota del mismo cobro");
    check(st.tags.length === 0, "G: no se re-etiqueta el lead");
  }

  /* ─────────────────── H: el webhook es fail-closed ─────────────────── */
  {
    delete process.env.STRIPE_WEBHOOK_URL_SECRET;
    check(secretOk("") === false && secretOk("loquesea") === false,
      "H: sin secreto configurado el webhook no atiende a nadie");
    process.env.STRIPE_WEBHOOK_URL_SECRET = "s3cr3t0-largo-de-verdad";
    check(secretOk("s3cr3t0-largo-de-verdad") === true, "H: con el secreto correcto pasa");
    check(secretOk("s3cr3t0-largo-de-verda") === false, "H: un secreto más corto no pasa");
    check(secretOk("S3CR3T0-largo-de-verdad") === false, "H: distingue mayúsculas");
    check(secretOk(undefined) === false, "H: sin parámetro no pasa");
  }

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main();
