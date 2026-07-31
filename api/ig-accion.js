// Webhook de Telegram: ejecuta el tap de Gerónimo sobre una propuesta del copiloto.
//
// Registrar una sola vez (el secret_token evita que cualquiera POSTee acá):
//   curl -F "url=https://minka-webhooks.vercel.app/api/ig-accion" \
//        -F "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
//        -F "allowed_updates=[\"callback_query\",\"message\"]" \
//        "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook"
//
// Para EDITAR un borrador antes de mandarlo: responder (reply) al mensaje de la propuesta con
// el texto corregido. Se publica ese texto en vez del borrador.

const ig = require("../lib/ig");
const tg = require("../lib/telegram");

const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

// El borrador viaja en el propio mensaje (callback_data tope 64 bytes). Se extrae del bloque
// <code> que puso lib/telegram.propuesta().
function borradorDe(texto) {
  const m = String(texto || "").match(/✍️ Borrador:\s*\n([\s\S]*?)(?:\n\n🎯|\n🏪|$)/);
  return m ? m[1].trim() : null;
}
function comentarioDe(texto) {
  const m = String(texto || "").match(/^\s*«([\s\S]*?)»\s*$/m);
  return m ? m[1] : "";
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  // FAIL-CLOSED (regla del repo): si el secreto no está configurado se RECHAZA, nunca se
  // salta la verificación. Este endpoint publica en Instagram con la cara de la marca.
  if (!SECRET || req.headers["x-telegram-bot-api-secret-token"] !== SECRET) {
    return res.status(401).json({ error: "secret inválido o sin configurar" });
  }

  const upd = req.body || {};
  res.status(200).json({ ok: true }); // Telegram reintenta ante demora: se contesta ya

  try {
    // A) Edición: responder al mensaje de la propuesta con el texto corregido
    if (upd.message?.reply_to_message) {
      const orig = upd.message.reply_to_message;
      const id = (orig.reply_markup?.inline_keyboard || [])
        .flat()
        .map((b) => String(b.callback_data || ""))
        .find((d) => d.startsWith("send:") || d.startsWith("hide:"))
        ?.split(":")[1];
      const nuevo = (upd.message.text || "").trim();
      if (id && nuevo) {
        await ig.responder(id, nuevo);
        await tg.aviso(`✅ Publicado con TU edición:\n${nuevo}`);
      }
      return;
    }

    // B) Botones
    const cb = upd.callback_query;
    if (!cb) return;
    const [accion, commentId] = String(cb.data || "").split(":");
    const texto = cb.message?.text || "";
    let nota = "";

    if (accion === "send") {
      const borrador = borradorDe(texto);
      if (!borrador) {
        nota = "no encontré el borrador";
      } else {
        await ig.responder(commentId, borrador);
        nota = "publicado ✅";
      }
    } else if (accion === "hide") {
      await ig.ocultar(commentId);
      nota = "oculto 🙈";
    } else if (accion === "skip") {
      nota = "ignorado";
    } else {
      nota = "acción desconocida";
    }

    await tg.llamar("answerCallbackQuery", {
      callback_query_id: cb.id, text: nota, chat_id: undefined,
    });
    // Se quitan los botones para que no se pueda publicar dos veces el mismo borrador.
    await tg.llamar("editMessageReplyMarkup", {
      message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] },
    });
    await tg.aviso(`↳ ${nota} · @${cb.from?.username || "tú"}` +
                   (comentarioDe(texto) ? `\n(sobre: «${comentarioDe(texto).slice(0, 80)}»)` : ""));
  } catch (e) {
    console.error("ig-accion", e);
    await tg.aviso(`⚠️ Copiloto IG: falló la acción — ${e.message}`);
  }
};
