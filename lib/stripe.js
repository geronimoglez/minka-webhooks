// lib/stripe.js — cliente mínimo de Stripe sobre fetch, sin dependencias.
//
// Stripe es greenfield en Minka: no había integración previa. Se usa la API REST directamente en
// vez del SDK porque este repo no tiene dependencias ni build step, y de toda la API sólo
// necesitamos dos llamadas: crear una Checkout Session y volver a leerla.
//
// La cuenta de Stripe es de MINKA (la agencia), no del cliente. Por eso el cargo aparece a nombre
// de Minka en el estado de cuenta del postulante, y por eso el aviso de privacidad tiene que
// decirlo: cobrar con un nombre que la persona no reconoce es la receta de un contracargo.
//
// REGLA DE ORO: la llave secreta jamás sale de aquí ni aparece en un log. Los errores se reducen a
// un token corto (`stripe-http-402`, `stripe-timeout`) antes de propagarse.

const API = "https://api.stripe.com/v1";
const TIMEOUT_MS = 10_000;

const secret = () => process.env.STRIPE_SECRET_KEY || "";

// ¿Estamos en modo real o de prueba? Se deduce de la propia llave, no de una variable aparte que
// alguien pueda dejar desalineada. Sirve para rechazar una sesión cuyo `livemode` no corresponde.
const isLive = () => /^sk_live_/.test(secret());

// Aplana un objeto a la notación con corchetes que espera Stripe:
//   {a:{b:"c"}, d:[{e:1}]}  →  a[b]=c & d[0][e]=1
function encodeForm(obj, prefix = "", out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => encodeForm({ [i]: item }, key, out));
    else if (typeof v === "object") encodeForm(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function call(path, { method = "GET", form, idempotencyKey } = {}) {
  if (!secret()) throw new Error("stripe-no-key"); // fail-closed: sin llave no se cobra nada
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let r, data;
  try {
    const headers = {
      Authorization: `Bearer ${secret()}`,
      "Stripe-Version": "2024-06-20", // versión fijada: que Stripe evolucione no nos cambia el contrato
    };
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    r = await fetch(`${API}${path}`, {
      method, headers, signal: controller.signal,
      body: form ? encodeForm(form).join("&") : undefined,
    });
    data = await r.json();
  } catch (e) {
    throw new Error(e && e.name === "AbortError" ? "stripe-timeout" : "stripe-network");
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) {
    // El `message` de Stripe puede citar el email del cliente → no se propaga. Sólo el código.
    const code = String(data?.error?.code || data?.error?.type || "error").replace(/[^a-z_]/gi, "");
    throw new Error(`stripe-http-${r.status}:${code}`.slice(0, 60));
  }
  return data;
}

// Crea la sesión de pago del apartado.
//
// `metadata.leadId` es lo que después permite atribuir el pago a la postulación correcta. Va en la
// sesión (no en la URL de retorno) porque es Stripe quien nos lo devolverá firmado por el hecho de
// que sólo nuestra llave secreta puede leerlo.
async function createCheckoutSession({ leadId, tenant, amountMxn, origin, evento, email }) {
  const pesos = Math.trunc(Number(amountMxn));
  if (!Number.isSafeInteger(pesos) || pesos < 1) throw new Error("stripe-bad-amount");

  // Idempotencia por hora: dos toques seguidos al botón reusan la MISMA sesión (no se cobra dos
  // veces); un reintento legítimo al día siguiente crea una nueva, en vez de resucitar una caducada.
  const bucket = Math.floor(Date.now() / 3_600_000);
  const idempotencyKey = `apartado-${tenant}-${leadId}-${pesos}-${bucket}`;

  return call("/checkout/sessions", {
    method: "POST",
    idempotencyKey,
    form: {
      mode: "payment",
      locale: "es",
      client_reference_id: `lead-${leadId}`,
      customer_email: email || undefined,
      success_url: `${origin}/postulacion/pagado?s={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/postulacion/pagado?s={CHECKOUT_SESSION_ID}&c=1`,
      metadata: { leadId: String(leadId), tenant, evento },
      payment_intent_data: {
        description: `Apartado de lugar — ${evento} (lead ${leadId})`,
        metadata: { leadId: String(leadId), tenant, evento },
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "mxn",
          unit_amount: pesos * 100, // Stripe cobra en centavos
          product_data: {
            name: "Apartado de lugar — Íconos de la Belleza IV",
            description: "Se abona al precio de tu pase. No es reembolsable si decides no asistir.",
          },
        },
      }],
    },
  });
}

const retrieveSession = (id) => call(`/checkout/sessions/${encodeURIComponent(id)}`);

// Un id de sesión de Checkout siempre es cs_test_… o cs_live_…. Validar la forma ANTES de llamar
// evita convertir un parámetro cualquiera de la URL en una petición a Stripe.
const isSessionId = (s) => /^cs_(test|live)_[A-Za-z0-9]{8,}$/.test(String(s || ""));

module.exports = { createCheckoutSession, retrieveSession, isSessionId, isLive, encodeForm, call };
