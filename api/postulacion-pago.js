// POST /postulacion/pago  — arranca el cobro del apartado.
//
// Recibe el token firmado de la pantalla de gracias, crea la Checkout Session en la cuenta de
// Stripe de MINKA y manda el navegador a Stripe con un 303.
//
// El monto NO viene del cliente: sale de EVENTO_APARTADO_MXN. Un precio que viaje en el formulario
// es un precio que el cliente puede editar antes de enviarlo.

const sign = require("../lib/sign");
const stripe = require("../lib/stripe");
const { config } = require("../lib/evento");
const { avisoPage, setSecurityHeaders } = require("../lib/postulacion_html");

module.exports = async (req, res) => {
  const cfg = config();
  setSecurityHeaders(res);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Método no permitido");
  }

  const token = String((req.body || {}).t || "");
  const v = sign.verify(token, { secret: process.env.POSTULACION_TOKEN_SECRET });
  if (!v.ok) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(400).send(avisoPage({
      cfg,
      titulo: "Este enlace ya no sirve",
      mensaje: "El enlace para apartar tu lugar caducó o está incompleto. Tu postulación sigue " +
               "guardada — escríbenos y te pasamos uno nuevo.",
      codigo: v.reason,
    }));
  }

  try {
    const session = await stripe.createCheckoutSession({
      leadId: v.leadId,
      tenant: cfg.tenant,
      amountMxn: cfg.apartadoMxn,
      origin: cfg.origin,
      evento: "Íconos de la Belleza IV",
    });
    if (!session || !session.url) throw new Error("stripe-no-url");
    res.setHeader("Location", session.url);
    return res.status(303).end();
  } catch (e) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(502).send(avisoPage({
      cfg,
      titulo: "No pudimos abrir el pago",
      mensaje: "La pasarela no respondió. No se te cobró nada y tu postulación está guardada. " +
               "Inténtalo otra vez en un minuto o apártalo por WhatsApp.",
      codigo: String(e.message || "").slice(0, 40),
    }));
  }
};
