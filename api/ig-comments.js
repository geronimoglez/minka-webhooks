// Webhook de comentarios de Instagram — el copiloto de @minka.one.
//
// Flujo: comentario nuevo → clasificar (10 arquetipos) → o se responde solo (solo donde el
// downside es cero), o se redacta un borrador y se manda a Telegram con botones para que
// Gerónimo lo apruebe de un tap. Doctrina: repo MinkaDigital-mktAIDir →
// docs/instagram-moderacion-copiloto.md §MODO AUDIENCIA.
//
// Configuración en la app `minka-assistant` de Meta (Instagram → Configurar webhooks):
//   URL de callback: https://minka-webhooks.vercel.app/api/ig-comments
//   Token de verificación: el valor de IG_VERIFY_TOKEN
//   Campo suscrito: `comments`
// La cuenta debe tener la suscripción ACTIVADA (el toggle de la tabla de cuentas).

const ig = require("../lib/ig");
const copiloto = require("../lib/copiloto");
const tg = require("../lib/telegram");

// Vercel parsea el body y perdemos el crudo, que es lo que Meta firma. Se lee el stream.
module.exports.config = { api: { bodyParser: false } };

function leerCrudo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    req.on("data", (c) => partes.push(c));
    req.on("end", () => resolve(Buffer.concat(partes)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  // 1) Handshake de verificación de Meta
  if (req.method === "GET") {
    const q = req.query || {};
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === ig.VERIFY_TOKEN) {
      return res.status(200).send(q["hub.challenge"]);
    }
    return res.status(403).send("forbidden");
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const crudo = await leerCrudo(req);
  if (!ig.firmaValida(crudo, req.headers["x-hub-signature-256"])) {
    // El endpoint es público: sin firma válida no se procesa nada.
    return res.status(401).json({ error: "firma inválida" });
  }

  let payload;
  try {
    payload = JSON.parse(crudo.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "body no es JSON" });
  }

  // Se responde 200 YA: Meta reintenta ante cualquier demora o error, y un reintento
  // significa procesar el mismo comentario otra vez.
  res.status(200).json({ ok: true });

  try {
    await procesar(payload);
  } catch (e) {
    console.error("ig-comments: fallo procesando", e);
    await tg.aviso(`⚠️ Copiloto IG: fallo procesando un comentario — ${e.message}`);
  }
};

async function procesar(payload) {
  const cuenta = await ig.yo().catch(() => null);
  const entradas = payload.entry || [];

  for (const entry of entradas) {
    for (const ch of entry.changes || []) {
      if (ch.field !== "comments") continue;
      const v = ch.value || {};
      const commentId = v.id;
      if (!commentId) continue;

      // Nunca reaccionar a los comentarios de la propia cuenta: nos responderíamos solos.
      const autorId = v.from?.id;
      if (autorId && cuenta && String(autorId) === String(cuenta.user_id)) continue;

      const texto = v.text || "";
      if (!texto.trim()) continue;

      // Deduplicación contra el hilo real, no contra memoria local: en serverless no hay
      // estado que sobreviva a un arranque en frío, y Meta reintenta el webhook.
      if (cuenta?.username && (await ig.yaRespondido(commentId, cuenta.username))) continue;

      let contexto = "";
      try {
        const c = await ig.getComentario(commentId);
        contexto = c?.media?.caption || "";
      } catch { /* el contexto es un lujo, no un requisito */ }

      const analisis = await copiloto.analizar(texto, contexto);
      const plan = copiloto.decidir(analisis);
      const autor = v.from?.username || "alguien";

      if (plan.accion === "ocultar" && plan.modo === "auto") {
        await ig.ocultar(commentId).catch((e) => console.error("ocultar", e.message));
        await tg.aviso(`🧹 Oculté spam de @${autor}: «${texto.slice(0, 120)}»`);
        continue;
      }

      if (plan.modo === "auto") {
        await ig.responder(commentId, analisis.borrador);
        await tg.aviso(
          `✅ Respondí solo (${plan.etiqueta})\n\n@${autor}: «${texto.slice(0, 160)}»\n` +
          `↳ ${analisis.borrador}`
        );
        continue;
      }

      // borrador o manual → a Telegram con botones
      await tg.propuesta({ commentId, autor, texto, analisis, plan });
    }
  }
}
