// Webhook de Telegram: ejecuta el tap de Gerónimo sobre una propuesta del copiloto.
//
// Registrar una sola vez (el secret_token evita que cualquiera POSTee acá):
//   curl -F "url=https://minka-webhooks.vercel.app/api/ig-accion" \
//        -F "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
//        -F "allowed_updates=[\"callback_query\",\"message\"]" \
//        "https://api.telegram.org/bot$COPILOTO_BOT_TOKEN/setWebhook"
//
// Para EDITAR un borrador antes de mandarlo: responder (reply) al mensaje de la propuesta con
// el texto corregido. Se publica ese texto en vez del borrador.

const ig = require("../lib/ig");
const tg = require("../lib/telegram");
const tenants = require("../lib/tenants");
const { agendar } = require("../lib/despues");

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

/**
 * `accion:tenant:commentId`. Las propuestas viejas traen `accion:commentId` sin tenant y
 * siguen sirviendo: pueden estar en el chat desde antes del multi-tenant.
 */
function leerRef(data) {
  const p = String(data || "").split(":");
  return p.length >= 3
    ? { accion: p[0], clave: p[1], commentId: p.slice(2).join(":") }
    : { accion: p[0], clave: null, commentId: p[1] || "" };
}

/** Cliente de Instagram del tenant al que pertenece este botón, o null si no se puede. */
function apiDe(clave) {
  const t = tenants.porClave(clave);
  if (!t) { console.warn(`ig-accion: tenant «${clave}» desconocido`); return null; }
  if (!t.token) { console.error(`ig-accion: tenant ${t.clave} sin token (${t.tokenEnv})`); return null; }
  return ig.cliente(t.token);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  // FAIL-CLOSED (regla del repo): si el secreto no está configurado se RECHAZA, nunca se
  // salta la verificación. Este endpoint publica en Instagram con la cara de la marca.
  if (!SECRET || req.headers["x-telegram-bot-api-secret-token"] !== SECRET) {
    return res.status(401).json({ error: "secret inválido o sin configurar" });
  }

  const upd = req.body || {};
  console.log("ig-accion:", upd.callback_query ? `botón ${upd.callback_query.data}`
    : upd.message ? `mensaje «${String(upd.message.text || "").slice(0, 40)}»` : "update ignorado");

  const trabajo = procesar(upd).catch(async (e) => {
    console.error("ig-accion: fallo", e);
    await tg.aviso(`⚠️ Copiloto IG: falló la acción — ${e.message}`).catch(() => {});
  });

  // Contestar 200 TERMINA la invocación en serverless: lo pendiente se congela sin dejar
  // rastro. O la plataforma se hace cargo del trabajo, o se espera antes de responder.
  if (!agendar(trabajo)) await trabajo;
  return res.status(200).json({ ok: true });
};

async function procesar(upd) {
  // A0) Mensaje suelto (no es respuesta a una propuesta). Sin esto el bot es un agujero
  // negro: escribes y no contesta nada, que parece que está roto. Además devuelve el
  // chat_id, que es justo el dato que hace falta para configurarlo.
  if (upd.message && !upd.message.reply_to_message) {
    const m = upd.message;
    const chatId = m.chat.id;
    const texto = (m.text || "").trim();
    const ayuda =
      "🤖 <b>Copiloto de comentarios</b> — estoy vivo.\n\n" +
      "No soy conversacional: solo te aviso cuando alguien comenta en Instagram y te " +
      "mando el borrador con botones.\n\n" +
      "• <b>Enviar</b> publica el borrador tal cual\n" +
      "• <b>Ocultar</b> esconde el comentario (no lo borra)\n" +
      "• Para corregir: <b>responde</b> a mi mensaje con tu texto y publico el tuyo\n\n" +
      `Manda <code>/prueba</code> para ver una propuesta de ejemplo.\n` +
      `Tu <code>chat_id</code> es <code>${chatId}</code>`;
    await tg.llamar("sendMessage", { chat_id: chatId, text: ayuda, parse_mode: "HTML" });
    if (texto === "/prueba") {
      await tg.propuesta({
        commentId: "PRUEBA", autor: "un_prospecto", chatId, tenant: "prueba",
        texto: "¿Y esto sirve para una taquería o solo para negocios grandes?",
        analisis: { arquetipo: "esceptico", confianza: 0.82,
          borrador: "Sirve, y te digo cuándo no: si tus clientes llegan y compran sin " +
                    "preguntar, no lo necesitas. ¿A ti te escriben antes de ir?",
          dolor: "solo para negocios grandes", giro: "taquería" },
        plan: { modo: "borrador", etiqueta: "Escéptico de giro ⭐ (PRUEBA)", accion: null },
      });
    }
    return;
  }

  // A) Edición: responder al mensaje de la propuesta con el texto corregido
  if (upd.message?.reply_to_message) {
    const orig = upd.message.reply_to_message;
    const data = (orig.reply_markup?.inline_keyboard || [])
      .flat()
      .map((b) => String(b.callback_data || ""))
      .find((d) => d.startsWith("send:") || d.startsWith("hide:"));
    const { clave, commentId } = leerRef(data);
    const nuevo = (upd.message.text || "").trim();
    const chatId = upd.message.chat.id;
    if (!commentId || !nuevo) return;
    if (commentId === "PRUEBA") {
      await tg.aviso(`🧪 Era una prueba: tu edición «${nuevo}» NO se publicó en Instagram.`, chatId);
      return;
    }
    const api = apiDe(clave);
    if (!api) {
      await tg.aviso("⚠️ No pude identificar la cuenta de esa propuesta.", chatId);
      return;
    }
    await api.responder(commentId, nuevo);
    await tg.aviso(`✅ Publicado con TU edición:\n${nuevo}`, chatId);
    return;
  }

  // B) Botones
  const cb = upd.callback_query;
  if (!cb) return;
  const { accion, clave, commentId } = leerRef(cb.data);
  const texto = cb.message?.text || "";
  const chatId = cb.message?.chat?.id;
  let nota = "";

  // La propuesta de /prueba no toca Instagram: sirve para verificar la vuelta completa
  // (Telegram → Vercel → acción) sin esperar a que alguien comente de verdad.
  if (commentId === "PRUEBA") {
    nota = `prueba ok — «${accion}» llegó al servidor`;
  } else if (accion === "skip") {
    nota = "ignorado";
  } else if (accion !== "send" && accion !== "hide") {
    nota = "acción desconocida";
  } else {
    const api = apiDe(clave);
    if (!api) {
      nota = "no identifiqué la cuenta";
    } else if (accion === "hide") {
      await api.ocultar(commentId);
      nota = "oculto 🙈";
    } else {
      const borrador = borradorDe(texto);
      if (!borrador) {
        nota = "no encontré el borrador";
      } else {
        // Telegram reintenta el update si tardamos, y un reintento publicaría dos veces la
        // misma respuesta con la cara de la marca. La verdad vive en el hilo, no acá.
        const cuenta = await api.yo().catch(() => null);
        if (cuenta?.username && (await api.yaRespondido(commentId, cuenta.username))) {
          nota = "ya estaba respondido";
        } else {
          await api.responder(commentId, borrador);
          nota = "publicado ✅";
        }
      }
    }
  }

  await tg.llamar("answerCallbackQuery", { callback_query_id: cb.id, text: nota });
  // Se quitan los botones para que no se pueda publicar dos veces el mismo borrador.
  await tg.llamar("editMessageReplyMarkup", {
    chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] },
  });
  await tg.aviso(`↳ ${nota} · @${cb.from?.username || "tú"}` +
                 (comentarioDe(texto) ? `\n(sobre: «${comentarioDe(texto).slice(0, 80)}»)` : ""),
                 chatId);
}
