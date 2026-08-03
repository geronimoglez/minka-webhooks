// POST /api/stripe-webhook?k=<secreto>  — el otro camino por el que se entera del pago.
//
// Existe para el caso que el retorno del navegador no cubre: la persona paga y cierra la pestaña
// antes de que Stripe la redirija. Sin esto, ese dinero estaría cobrado y la postulación seguiría
// marcada como no apartada.
//
// ── Cómo está asegurado ──────────────────────────────────────────────────────────────────────
// NO se confía en el cuerpo de la petición. De todo el JSON que manda Stripe se lee UNA cosa: el
// id de la sesión. Ese id se vuelve a consultar contra la API de Stripe con nuestra llave secreta,
// y de ESA respuesta salen el estado del pago, el monto y a qué lead pertenece. Un cuerpo
// falsificado no puede inventar un pago: tendría que inventar una sesión que Stripe confirme.
//
// Encima va un secreto propio en la URL, fail-closed (sin `STRIPE_WEBHOOK_URL_SECRET` configurado
// el endpoint no atiende a nadie), para que ni siquiera se llegue a llamar a Stripe desde una
// petición anónima.
//
// ⚠️ Ese secreto va en la QUERY STRING, así que hay que asumir que termina en los logs de acceso de
// la plataforma, donde lo puede leer más gente que la que tiene acceso a las variables de entorno
// (Stripe no permite cabeceras propias en sus endpoints de webhook, así que no hay dónde más
// ponerlo). Por eso el secreto NO es la frontera de seguridad: es un portero que evita que
// cualquiera nos haga gastar llamadas a Stripe. La frontera real es la re-consulta — con el secreto
// filtrado, lo peor que consigue alguien es provocar una escritura idempotente de un pago que
// Stripe confirma como cierto. Aun así conviene rotarlo cada tanto (ver .env.example).
// Ship-review 2026-07-30.
//
// Por qué no se verifica la firma `Stripe-Signature`: hacerlo exige los BYTES EXACTOS del cuerpo, y
// en el runtime Node de Vercel el cuerpo `application/json` ya viene parseado a objeto cuando el
// handler corre — los bytes originales no se conservan, y re-serializar no reproduce la firma. En
// vez de dejar una verificación que a veces corre y a veces no (peor que no tenerla, porque invita
// a confiar), la garantía se pone donde sí es sólida: el secreto de la URL y la re-consulta. El
// resultado es más fuerte que verificar la firma y creerle al payload, porque aquí el payload no
// se usa para nada más que un id.

const { confirm } = require("../lib/apartado");
const { config } = require("../lib/evento");
const stripe = require("../lib/stripe");
const crypto = require("crypto");

// Eventos que significan "el dinero entró". `async_payment_succeeded` cubre los métodos diferidos
// (OXXO, transferencia SPEI), donde el pago se confirma minutos u horas después del checkout.
const EVENTOS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

// Comparación en tiempo constante del secreto de la URL.
function secretOk(given) {
  const expected = process.env.STRIPE_WEBHOOK_URL_SECRET || "";
  if (!expected) return false; // fail-closed: sin secreto configurado, nadie pasa
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method" });
  }
  if (!secretOk((req.query || {}).k)) return res.status(401).json({ error: "unauthorized" });

  try {
    const body = req.body || {};
    const tipo = String(body.type || "");
    if (!EVENTOS.has(tipo)) return res.status(200).json({ ok: true, ignored: tipo.slice(0, 60) });

    // Lo ÚNICO que se toma del cuerpo.
    const sessionId = String(body?.data?.object?.id || "");
    if (!stripe.isSessionId(sessionId)) return res.status(200).json({ ok: true, ignored: "bad-id" });

    const r = await confirm(sessionId, config());

    // 5xx = "vuelve a intentar". Stripe reintenta con backoff durante días, así que un Odoo dormido
    // o un hipo de red no pierden el registro del pago. `confirm` es idempotente: el reintento no
    // duplica nada.
    if (!r.ok) {
      console.error(`[stripe-webhook] ${tipo} sin registrar (${r.reason}) — se pide reintento a Stripe`);
      return res.status(500).json({ ok: false, reason: r.reason });
    }

    return res.status(200).json({ ok: true, paid: r.paid, deduped: Boolean(r.deduped) });
  } catch (e) {
    // El camino del dinero es justo el que hay que poder depurar a las 3 de la mañana.
    console.error("[stripe-webhook] fallo no controlado:", e && e.message);
    return res.status(500).json({ ok: false, reason: "handler-error" });
  }
};

module.exports.__secretOk = secretOk;
module.exports.__EVENTOS = EVENTOS;
