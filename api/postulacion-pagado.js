// GET /postulacion/pagado?s=<session_id>[&c=1]  — retorno del navegador desde Stripe.
//
// Es a la vez el success_url y el cancel_url: los dos vuelven aquí y quien decide si hubo pago es
// Stripe, no el parámetro de la URL. `c=1` sólo sirve para no molestar a Stripe cuando ya sabemos
// que la persona canceló.
//
// No hace falta traer el token firmado desde Stripe: el id de la sesión ES la prueba. Se consulta
// la sesión con la llave secreta, de ahí sale a qué lead pertenece, y con eso se emite un token
// nuevo para volver a la pantalla de gracias. Así nuestro token nunca queda guardado en Stripe.

const sign = require("../lib/sign");
const stripe = require("../lib/stripe");
const { confirm } = require("../lib/apartado");
const { config } = require("../lib/evento");
const { avisoPage } = require("../lib/postulacion_html");

module.exports = async (req, res) => {
  const cfg = config();
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  const q = req.query || {};
  const sessionId = String(q.s || "");
  const cancelado = String(q.c || "") === "1";

  const irAGracias = (leadId, p) => {
    let t = "";
    try { t = sign.issue(leadId, { secret: process.env.POSTULACION_TOKEN_SECRET }); } catch { t = ""; }
    const qs = new URLSearchParams(t ? { t, p } : { p }).toString();
    res.setHeader("Location", `/postulacion/gracias?${qs}`);
    return res.status(303).end();
  };

  // Cancelación: no se toca el CRM. Sólo se recupera a qué lead volver.
  if (cancelado) {
    if (!stripe.isSessionId(sessionId)) {
      res.setHeader("Location", "/postulacion/gracias?p=no");
      return res.status(303).end();
    }
    try {
      const s = await stripe.retrieveSession(sessionId);
      const leadId = Number(s.metadata && s.metadata.leadId);
      if (Number.isSafeInteger(leadId) && leadId > 0) return irAGracias(leadId, "no");
    } catch { /* da igual por qué: se cae al camino sin token */ }
    res.setHeader("Location", "/postulacion/gracias?p=no");
    return res.status(303).end();
  }

  const r = await confirm(sessionId, cfg);

  if (r.ok && r.paid && r.leadId) return irAGracias(r.leadId, "ok");
  // Pagado pero no lo pudimos registrar: el dinero ya se cobró, así que NO se le dice a la persona
  // que falló su pago. Se le confirma y el problema se resuelve del lado nuestro (el webhook
  // reintenta, y el aviso de Telegram ya alertó).
  if (r.paid && r.leadId) return irAGracias(r.leadId, "ok");
  if (r.ok && !r.paid) {
    res.setHeader("Location", "/postulacion/gracias?p=pend");
    return res.status(303).end();
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(avisoPage({
    cfg,
    titulo: "No pudimos confirmar el pago",
    mensaje: "Si el cargo aparece en tu estado de cuenta, ya está hecho y nosotros lo registramos. " +
             "Escríbenos por WhatsApp y lo verificamos contigo en el momento.",
    codigo: String(r.reason || "").slice(0, 40),
  }));
};
