// test/handlers.test.js — Los handlers HTTP del embudo, ejercitados de verdad.
// Corre: `node test/handlers.test.js`. Exit 1 si falla algo. Sin deps.
//
// Hasta ahora los tests sólo tocaban las funciones puras que los handlers extraen (validate, sniff,
// secretOk…). Eso dejaba sin probar justo lo que ve un atacante o un usuario: el código de estado,
// el header Location, y si el CRM se toca o no. Un cambio que rompiera, por ejemplo, que la
// redirección sea RELATIVA (y sacara al usuario del dominio) pasaba sin que nada fallara.
// Ship-review 2026-07-30.

process.env.ODOO_URL_JUANELO = "https://juanelo.crm.minkadigital.com";
process.env.ODOO_DB_JUANELO = "juanelo";
process.env.ODOO_USER_JUANELO = "j@x.com";
process.env.ODOO_API_KEY_JUANELO = "key-juanelo";
process.env.ODOO_WAKE_RETRIES = "0";
process.env.EVENTO_CRM_TENANT = "juanelo";
process.env.EVENTO_APARTADO_MXN = "100";
process.env.POSTULACION_TOKEN_SECRET = "secreto-de-pruebas-handlers";
process.env.STRIPE_SECRET_KEY = "sk_test_ejemplo";
process.env.STRIPE_WEBHOOK_URL_SECRET = "secreto-webhook-de-pruebas";
delete process.env.CRM_DRIVER;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

const sign = require("../lib/sign.js");
const crm = require("../lib/crm.js");
const hPostulacion = require("../api/postulacion.js");
const hGracias = require("../api/postulacion-gracias.js");
const hPago = require("../api/postulacion-pago.js");
const hDocs = require("../api/postulacion-documentos.js");
const hWebhook = require("../api/stripe-webhook.js");

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log(" FAIL  " + label); }
}

/* ── Arnés mínimo de req/res, con la forma que usa el runtime Node de Vercel ── */
function mkRes() {
  const res = { statusCode: 0, headers: {}, body: "", ended: false };
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = String(v); return res; };
  res.getHeader = (k) => res.headers[String(k).toLowerCase()];
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = String(b); res.ended = true; return res; };
  res.json = (o) => { res.body = JSON.stringify(o); res.ended = true; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}
const mkReq = (o = {}) => ({
  method: o.method || "GET", body: o.body, query: o.query || {},
  headers: Object.assign({ "x-forwarded-for": o.ip || "10.0.0.1" }, o.headers || {}),
});
const call = async (h, reqOpts) => { const res = mkRes(); await h(mkReq(reqOpts), res); return res; };

// Odoo falso: cuenta las escrituras para poder afirmar "no se tocó el CRM".
function mockOdoo() {
  const st = { escrituras: 0, ops: [] };
  global.fetch = async (url, opts) => {
    if (String(url).startsWith("https://api.stripe.com/")) {
      return { ok: false, status: 404, json: async () => ({ error: { code: "resource_missing" } }) };
    }
    const p = JSON.parse(opts.body).params;
    if (p.service === "common") return { status: 200, json: async () => ({ result: 2 }) };
    const [db, uid, key, model, method] = p.args;
    st.ops.push({ model, method });
    if (["create", "write", "message_post", "unlink"].includes(method)) st.escrituras++;
    if (method === "search") return { status: 200, json: async () => ({ result: [] }) };
    return { status: 200, json: async () => ({ result: 77 }) };
  };
  return st;
}

const FORMA_OK = {
  nombre: "Rosa Martínez", whatsapp: "+52 33 1234 5678", email: "rosa@ejemplo.mx",
  ciudad: "Guadalajara, Jalisco",
  trayectoria: "Llevo doce años con mi estudio de belleza y he formado a más de cuarenta estilistas.",
  privacidad: "si",
};

async function main() {
  /* ── A: GET /postulacion ── */
  {
    mockOdoo();
    const r = await call(hPostulacion, { method: "GET" });
    check(r.statusCode === 200, "A: GET responde 200");
    check(/text\/html/.test(r.headers["content-type"]), "A: responde HTML");
    check(/s-maxage/.test(r.headers["cache-control"] || ""), "A: la forma vacía se cachea en el edge");
    check(/default-src 'none'/.test(r.headers["content-security-policy"] || ""), "A: manda CSP estricta");
    check(r.body.includes("<form"), "A: el cuerpo trae la forma");
    check(!/<script/i.test(r.body), "A: cero JavaScript");
  }

  /* ── B: métodos no permitidos ── */
  {
    const r = await call(hPostulacion, { method: "DELETE" });
    check(r.statusCode === 405 && r.headers["allow"] === "GET, POST", "B: DELETE → 405 con Allow");
    const g = await call(hGracias, { method: "POST" });
    check(g.statusCode === 405, "B: POST a /gracias → 405");
    const p = await call(hPago, { method: "GET" });
    check(p.statusCode === 405, "B: GET a /pago → 405");
    const w = await call(hWebhook, { method: "GET" });
    check(w.statusCode === 405, "B: GET al webhook → 405");
  }

  /* ── C: honeypot — un bot no debe tocar el CRM ── */
  {
    const st = mockOdoo();
    const r = await call(hPostulacion, { method: "POST", ip: "10.0.0.99",
      body: { ...FORMA_OK, website_hp: "soy un bot" } });
    check(r.statusCode === 303, "C: el honeypot responde 303 como si nada");
    check(r.headers["location"] === "/postulacion/gracias", "C: sin token (no hay lead)");
    check(st.escrituras === 0, "C: CERO escrituras al CRM por un bot");
  }

  /* ── D: validación — 422 conservando lo escrito, sin tocar el CRM ── */
  {
    const st = mockOdoo();
    const r = await call(hPostulacion, { method: "POST", ip: "10.0.0.2",
      body: { ...FORMA_OK, email: "sin-arroba" } });
    check(r.statusCode === 422, "D: datos inválidos → 422");
    check(r.body.includes("Guadalajara, Jalisco"), "D: conserva lo que ya había escrito");
    check(r.body.includes("Revisa el correo"), "D: muestra el error del campo");
    check(r.headers["cache-control"] === "no-store", "D: una respuesta con datos personales no se cachea");
    check(st.escrituras === 0, "D: no se escribe nada en el CRM si la forma no pasa");
  }
  {
    const st = mockOdoo();
    const r = await call(hPostulacion, { method: "POST", ip: "10.0.0.3",
      body: { ...FORMA_OK, privacidad: "" } });
    check(r.statusCode === 422 && st.escrituras === 0,
      "D: sin aceptar el aviso de privacidad NO se guarda nada (LFPDPPP)");
  }

  /* ── E: envío correcto → 303 con Location RELATIVO y token válido ── */
  {
    crm.__resetCaches();
    const st = mockOdoo();
    const r = await call(hPostulacion, { method: "POST", ip: "10.0.0.4", body: FORMA_OK });
    check(r.statusCode === 303, "E: envío válido → 303");
    const loc = r.headers["location"] || "";
    check(loc.startsWith("/postulacion/gracias?t="), "E: Location RELATIVO (el usuario no sale del dominio)");
    check(!/^https?:/i.test(loc), "E: nunca una URL absoluta hacia minka-webhooks");
    const t = decodeURIComponent(loc.split("t=")[1] || "");
    const v = sign.verify(t, { secret: process.env.POSTULACION_TOKEN_SECRET });
    check(v.ok === true, "E: el token del redirect es válido");
    check(v.paid === false, "E: y NO viene marcado como pagado");
    check(!loc.includes("rosa@ejemplo.mx") && !loc.includes("Rosa"),
      "E: la URL no lleva ningún dato personal");
    check(st.escrituras > 0, "E: el lead sí se escribió en el CRM");
  }

  /* ── F: rate limit — el tope existe de verdad ── */
  {
    mockOdoo();
    let ultimo = null;
    for (let i = 0; i < 9; i++) {
      ultimo = await call(hPostulacion, { method: "POST", ip: "10.0.0.66", body: FORMA_OK });
    }
    check(ultimo.statusCode === 429, "F: tras varios envíos seguidos desde la misma IP → 429");
    const otra = await call(hPostulacion, { method: "POST", ip: "10.0.0.67", body: FORMA_OK });
    check(otra.statusCode === 303, "F: otra IP no queda castigada por el vecino");
  }

  /* ── G: /gracias — el estado de pago sale del token, no de la URL ── */
  {
    const secret = process.env.POSTULACION_TOKEN_SECRET;
    const tNoPagado = sign.issue(31, { secret });
    const tPagado = sign.issue(31, { secret, paid: true });

    const a = await call(hGracias, { query: { t: tNoPagado } });
    check(a.statusCode === 200 && a.body.includes("/postulacion/pago"),
      "G: con token válido sin pagar, se ofrece el apartado");

    const b = await call(hGracias, { query: { t: tNoPagado, p: "ok" } });
    check(!b.body.includes("Lugar apartado"),
      "G: ?p=ok NO puede fingir un pago que el token no respalda");
    check(b.body.includes("/postulacion/pago"), "G: y se sigue ofreciendo el cobro");

    const c = await call(hGracias, { query: { t: tPagado, p: "ok" } });
    check(c.body.includes("Lugar apartado"), "G: con el token que SÍ dice pagado, se confirma");
    check(!c.body.includes("/postulacion/pago"), "G: y ya no se vuelve a ofrecer el cobro");

    const d = await call(hGracias, { query: { t: tNoPagado.slice(0, -4) + "xxxx" } });
    check(!d.body.includes("/postulacion/pago"),
      "G: con token de firma manipulada no se ofrece cobrar nada");
    check(d.headers["cache-control"].includes("no-store"), "G: la pantalla ligada a alguien no se cachea");
  }

  /* ── H: /pago — sin token válido no se abre ningún cobro ── */
  {
    for (const t of ["", "basura", sign.issue(9, { secret: "OTRO-SECRETO" })]) {
      const r = await call(hPago, { method: "POST", body: { t } });
      check(r.statusCode === 400, `H: token inválido (${JSON.stringify(String(t).slice(0, 12))}) → 400`);
    }
    const vencido = sign.issue(9, { secret: process.env.POSTULACION_TOKEN_SECRET, ttlMs: -1 });
    const r = await call(hPago, { method: "POST", body: { t: vencido } });
    check(r.statusCode === 400 && r.body.includes("ya no sirve"), "H: token vencido → mensaje honesto");
  }

  /* ── I: /documentos — un token forjado no toca el expediente de nadie ── */
  {
    const st = mockOdoo();
    const B = "----HandlerTest";
    const cuerpo = Buffer.concat([
      Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="t"\r\n\r\n`),
      Buffer.from("2.42.0.99999999999999.firmaInventada"),
      Buffer.from(`\r\n--${B}\r\nContent-Disposition: form-data; name="documentos"; filename="x.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`\r\n--${B}--\r\n`),
    ]);
    const res = mkRes();
    await hDocs(Object.assign(mkReq({ method: "POST" }), {
      body: cuerpo, headers: { "content-type": `multipart/form-data; boundary=${B}` },
    }), res);
    check(res.statusCode === 303, "I: token forjado → 303 (no revela si el lead existe)");
    check(res.headers["location"] === "/postulacion/gracias", "I: vuelve sin token");
    check(st.escrituras === 0, "I: CERO escrituras — no se adjunta nada al expediente de otro");
  }

  /* ── J: webhook de Stripe — fail-closed de verdad ── */
  {
    const evento = { type: "checkout.session.completed", data: { object: { id: "cs_test_abcdefgh12345" } } };
    const sinK = await call(hWebhook, { method: "POST", body: evento });
    check(sinK.statusCode === 401, "J: sin el secreto en la URL → 401");
    const malK = await call(hWebhook, { method: "POST", body: evento, query: { k: "equivocado" } });
    check(malK.statusCode === 401, "J: con el secreto equivocado → 401");

    const st = mockOdoo();
    const otroEvento = await call(hWebhook, { method: "POST", query: { k: process.env.STRIPE_WEBHOOK_URL_SECRET },
      body: { type: "customer.created", data: { object: { id: "cus_123" } } } });
    check(otroEvento.statusCode === 200 && st.escrituras === 0, "J: un evento que no nos toca se ignora sin escribir");

    const idMalo = await call(hWebhook, { method: "POST", query: { k: process.env.STRIPE_WEBHOOK_URL_SECRET },
      body: { type: "checkout.session.completed", data: { object: { id: "../../etc/passwd" } } } });
    check(idMalo.statusCode === 200 && JSON.parse(idMalo.body).ignored === "bad-id",
      "J: un id de sesión inventado se descarta sin llamar a Stripe");

    // Sesión que Stripe no reconoce → 500 para que Stripe reintente, sin escribir nada
    const st2 = mockOdoo();
    const fantasma = await call(hWebhook, { method: "POST", query: { k: process.env.STRIPE_WEBHOOK_URL_SECRET },
      body: evento });
    check(fantasma.statusCode === 500, "J: sesión no verificable → 500 (Stripe reintenta)");
    check(st2.escrituras === 0, "J: y no se registra ningún pago que Stripe no confirme");
  }

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main();
