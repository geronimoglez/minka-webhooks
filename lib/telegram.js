// Puente a Telegram para el copiloto de comentarios: avisos y propuestas con botones.
//
// El trabajo real de moderar no es escribir, es LEER todo y decidir a qué entrarle. Eso es lo
// que se automatiza: llega el comentario ya clasificado y con borrador, y Gerónimo aprueba de
// un tap. Su voz nunca se cede.

// Bot PROPIO del copiloto, separado del Director (@minka_director_bot).
//
// No es preferencia de orden: el Director corre en Railway por LONG POLLING, y Telegram no
// permite polling y webhook sobre el mismo token. Registrarle un webhook al Director lo
// dejaría sordo en producción. Por eso el copiloto tiene su propio bot.
// Fallback a TELEGRAM_BOT_TOKEN solo para no romper otros avisos del repo que ya lo usan.
const BOT = process.env.COPILOTO_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const API = (m) => `https://api.telegram.org/bot${BOT}/${m}`;
// TELEGRAM_CHAT_ID es el nombre que usa el resto del repo; TELEGRAM_DEFAULT_CHAT_ID es el que
// trae el environment del Motor. Se aceptan los dos para que no dependa de cuál se configuró.
const CHAT = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_DEFAULT_CHAT_ID;

// Métodos que sin destino no tienen sentido. answerCallbackQuery no lleva chat.
const NECESITAN_CHAT = new Set(["sendMessage", "sendPhoto", "editMessageReplyMarkup", "editMessageText"]);

async function llamar(metodo, body = {}) {
  if (!BOT) {
    console.warn("telegram: sin COPILOTO_BOT_TOKEN ni TELEGRAM_BOT_TOKEN, no se envía");
    return null;
  }
  // chat_id explícito (p.ej. contestarle a quien escribió) gana sobre el default del env.
  const payload = { ...body };
  if (payload.chat_id == null) {
    if (NECESITAN_CHAT.has(metodo) && CHAT) payload.chat_id = CHAT;
    else delete payload.chat_id;
  }
  if (NECESITAN_CHAT.has(metodo) && !payload.chat_id) {
    console.warn(`telegram: ${metodo} sin destino — falta TELEGRAM_CHAT_ID en el entorno`);
    return null;
  }
  const r = await fetch(API(metodo), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) console.error("telegram", metodo, r.status, (await r.text()).slice(0, 200));
  return r.ok ? r.json() : null;
}

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function aviso(texto, chatId) {
  return llamar("sendMessage", {
    text: texto, disable_web_page_preview: true, ...(chatId ? { chat_id: chatId } : {}),
  });
}

/**
 * Propuesta con botones. El callback_data de Telegram tope 64 bytes, así que solo viaja
 * `accion:commentId`; el borrador se recupera del propio mensaje al presionar.
 *
 * `chatId` opcional: sirve para contestar en el chat de quien pidió la prueba, en vez de
 * depender de que TELEGRAM_CHAT_ID esté configurado.
 */
async function propuesta({ commentId, autor, texto, analisis, plan, chatId, tenant }) {
  const manual = plan.modo === "manual";
  // La clave del tenant viaja en el botón: al presionarlo hay que saber contra QUÉ cuenta
  // actuar, y el mensaje puede llegar minutos u horas después. Cabe de sobra en los 64 bytes.
  const ref = `${tenant ? `${tenant}:` : ""}${commentId}`;
  const cuerpo =
    `💬 <b>${esc(plan.etiqueta)}</b>  <i>(confianza ${Number(analisis.confianza || 0).toFixed(2)})</i>\n\n` +
    `<b>@${esc(autor)}</b>\n«${esc(texto)}»\n\n` +
    (manual
      ? `🚫 <b>Esto lo contestas tú.</b> No redacté borrador a propósito.`
      : `✍️ <b>Borrador:</b>\n<code>${esc(analisis.borrador)}</code>`) +
    (analisis.dolor ? `\n\n🎯 <i>Dolor detectado:</i> «${esc(analisis.dolor)}»` : "") +
    (analisis.giro ? `\n🏪 <i>Giro:</i> ${esc(analisis.giro)}` : "");

  const botones = manual
    ? [[{ text: "🙈 Ocultar", callback_data: `hide:${ref}` },
        { text: "✔️ Ya lo vi", callback_data: `skip:${ref}` }]]
    : [[{ text: "✅ Enviar", callback_data: `send:${ref}` },
        { text: "🙈 Ocultar", callback_data: `hide:${ref}` },
        { text: "✖️ Ignorar", callback_data: `skip:${ref}` }]];

  return llamar("sendMessage", {
    text: cuerpo,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: botones },
    ...(chatId ? { chat_id: chatId } : {}),
  });
}

module.exports = { llamar, aviso, propuesta, esc };
