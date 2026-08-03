// lib/aviso.js — avisos operativos internos por Telegram.
//
// PRIVACIDAD (ship-review 2026-07-30). El aviso NO es el CRM: es un empujón para que alguien
// reaccione. Por eso, cuando el lead SÍ quedó guardado, aquí viaja lo mínimo para saber que pasó
// algo y poder abrirlo — el expediente completo ya está en Odoo, que es el sistema declarado en el
// aviso de privacidad. Mandar además nombre, teléfono, correo y el relato de la persona a un chat
// de Telegram duplicaba los datos en un destinatario extra, indefinidamente y sin forma de
// borrarlos (un historial de chat no se purga solo).
//
// La excepción es deliberada: si el CRM falló, el aviso ES la única copia de esa postulación, así
// que ahí sí viaja completo. Es la red de seguridad que evita perder a una persona porque Odoo
// estaba dormido — y por eso Telegram está declarado como destinatario en el aviso de privacidad.
//
// TIMEOUT: la llamada va en el camino de respuesta del usuario. Sin tope, una API de Telegram lenta
// se traduce en segundos de espera para alguien en el navegador de WhatsApp con red pobre, por un
// resultado que de todos modos se ignora.

const TIMEOUT_MS = 2500;

const token = () => process.env.TELEGRAM_BOT_TOKEN || "";
const chat = () => process.env.TELEGRAM_CHAT_ID || "";

// enviar(texto, etiqueta) → true si salió. Nunca lanza: un aviso fallido no puede tumbar el flujo.
async function enviar(text, etiqueta = "aviso") {
  if (!token() || !chat()) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token()}/sendMessage`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat(), text }),
    });
    if (!r.ok) {
      // Se registra el CÓDIGO, nunca el cuerpo: un error de Telegram puede eco-ar el mensaje, que
      // en el caso de degradación lleva datos de la persona.
      console.error(`[${etiqueta}] telegram respondió ${r.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[${etiqueta}] telegram falló: ${e && e.name === "AbortError" ? "timeout" : "red"}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { enviar, TIMEOUT_MS };
