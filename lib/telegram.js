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
const CHAT = process.env.TELEGRAM_CHAT_ID;

async function llamar(metodo, body) {
  // chat_id explícito (p.ej. responder a quien escribió) gana sobre el default del env.
  if (!BOT || (!CHAT && !body?.chat_id)) {
    console.warn("telegram: sin COPILOTO_BOT_TOKEN/CHAT_ID, no se envía");
    return null;
  }
  const r = await fetch(API(metodo), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, ...body }),
  });
  if (!r.ok) console.error("telegram", metodo, r.status, (await r.text()).slice(0, 200));
  return r.ok ? r.json() : null;
}

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function aviso(texto) {
  return llamar("sendMessage", { text: texto, disable_web_page_preview: true });
}

/**
 * Propuesta con botones. El callback_data de Telegram tope 64 bytes, así que solo viaja
 * `accion:commentId`; el borrador se recupera del propio mensaje al presionar.
 */
async function propuesta({ commentId, autor, texto, analisis, plan }) {
  const manual = plan.modo === "manual";
  const cuerpo =
    `💬 <b>${esc(plan.etiqueta)}</b>  <i>(confianza ${Number(analisis.confianza || 0).toFixed(2)})</i>\n\n` +
    `<b>@${esc(autor)}</b>\n«${esc(texto)}»\n\n` +
    (manual
      ? `🚫 <b>Esto lo contestas tú.</b> No redacté borrador a propósito.`
      : `✍️ <b>Borrador:</b>\n<code>${esc(analisis.borrador)}</code>`) +
    (analisis.dolor ? `\n\n🎯 <i>Dolor detectado:</i> «${esc(analisis.dolor)}»` : "") +
    (analisis.giro ? `\n🏪 <i>Giro:</i> ${esc(analisis.giro)}` : "");

  const botones = manual
    ? [[{ text: "🙈 Ocultar", callback_data: `hide:${commentId}` },
        { text: "✔️ Ya lo vi", callback_data: `skip:${commentId}` }]]
    : [[{ text: "✅ Enviar", callback_data: `send:${commentId}` },
        { text: "🙈 Ocultar", callback_data: `hide:${commentId}` },
        { text: "✖️ Ignorar", callback_data: `skip:${commentId}` }]];

  return llamar("sendMessage", {
    text: cuerpo,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: botones },
  });
}

module.exports = { llamar, aviso, propuesta, esc };
