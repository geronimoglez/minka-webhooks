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
const { confirm, fetchOwnSession } = require("../lib/apartado");
const { config } = require("../lib/evento");
const { avisoPage, setSecurityHeaders } = require("../lib/postulacion_html");

module.exports = async (req, res) => {
  const cfg = config();
  setSecurityHeaders(res);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");

  const q = req.query || {};
  const sessionId = String(q.s || "");
  const cancelado = String(q.c || "") === "1";

  // El token de vuelta lleva FIRMADO si el lugar ya está pagado, para que la pantalla de gracias no
  // tenga que creerle a un parámetro de la URL.
  const irAGracias = (leadId, p, paid = false) => {
    let t = "";
    try { t = sign.issue(leadId, { secret: process.env.POSTULACION_TOKEN_SECRET, paid }); } catch { t = ""; }
    const qs = new URLSearchParams(t ? { t, p } : { p }).toString();
    res.setHeader("Location", `/postulacion/gracias?${qs}`);
    return res.status(303).end();
  };
  const sinToken = (p) => {
    res.setHeader("Location", `/postulacion/gracias?p=${p}`);
    return res.status(303).end();
  };

  // Cancelación: no se toca el CRM. Sólo se recupera a qué lead volver — pero pasando por la MISMA
  // validación de pertenencia que el camino de confirmación (`fetchOwnSession`). Sin ella, un id de
  // sesión ajeno (de otro cliente que comparta la cuenta de Stripe de Minka, o uno filtrado en una
  // captura de pantalla) bastaba para que emitiéramos un token firmado del lead de otra persona —
  // y con ese token se le podían adjuntar documentos a su expediente. Ship-review 2026-07-30.
  if (cancelado) {
    const own = await fetchOwnSession(sessionId, cfg);
    if (!own.ok) {
      console.error(`[pagado] cancelación con sesión no propia: ${own.reason}`);
      return sinToken("no");
    }
    return irAGracias(own.leadId, "no", false);
  }

  const r = await confirm(sessionId, cfg);

  // Pagado y registrado.
  if (r.ok && r.paid && r.leadId) return irAGracias(r.leadId, "ok", true);
  // Pagado pero no lo pudimos registrar: el dinero ya se cobró, así que NO se le dice a la persona
  // que falló su pago. Se le confirma —el cobro es real— y el problema se resuelve del lado
  // nuestro (el webhook reintenta, y el aviso interno ya alertó).
  if (r.paid && r.leadId) return irAGracias(r.leadId, "ok", true);
  // Aún sin pagar (métodos diferidos como OXXO/SPEI): se vuelve con token pero sin marcar pagado.
  if (r.ok && !r.paid) {
    return r.leadId ? irAGracias(r.leadId, "pend", false) : sinToken("pend");
  }

  console.error(`[pagado] no se pudo confirmar la sesión: ${r.reason}`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(avisoPage({
    cfg,
    titulo: "No pudimos confirmar el pago",
    mensaje: "Si el cargo aparece en tu estado de cuenta, ya está hecho y nosotros lo registramos. " +
             "Escríbenos por WhatsApp y lo verificamos contigo en el momento.",
    codigo: String(r.reason || "").slice(0, 40),
  }));
};
