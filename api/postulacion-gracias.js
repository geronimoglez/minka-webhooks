// GET /postulacion/gracias?t=<token>[&d=…|&p=…]
//
// La pantalla que cobra. Llega aquí por el 303 de /postulacion, con un token firmado que dice a qué
// lead pertenece la sesión. El token no lleva datos personales (ver lib/sign.js): sólo el id del
// lead y una caducidad, firmados.
//
// Un token inválido o vencido NO es un error del que haya que asustarse: se pinta la versión sin
// pago, que encamina a WhatsApp. Nunca se revela si el lead existe.

const sign = require("../lib/sign");
const { config } = require("../lib/evento");
const { graciasPage } = require("../lib/postulacion_html");

module.exports = async (req, res) => {
  const cfg = config();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // La página está ligada a una postulación concreta → jamás en un cache compartido. Y sin Referer
  // hacia afuera, para que el token no viaje a Stripe ni a ningún tercero.
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET");
    return res.status(405).send("Método no permitido");
  }

  const q = req.query || {};
  const t = String(q.t || "");
  const v = t ? sign.verify(t, { secret: process.env.POSTULACION_TOKEN_SECRET }) : { ok: false };

  return res.status(200).send(graciasPage({
    token: v.ok ? t : "",
    cfg,
    query: { d: String(q.d || ""), p: String(q.p || ""), n: String(q.n || "") },
  }));
};
