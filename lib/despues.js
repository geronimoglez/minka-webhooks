// El bug que costó una tarde de depuración: **en Vercel, mandar la respuesta TERMINA la
// invocación**. Todo `await` que quedara pendiente se congela y no corre nunca — sin log, sin
// error, sin nada. El endpoint devuelve 200 impecable y el trabajo simplemente no sucede.
//
// Es una trampa fina porque el patrón "contesta 200 ya y procesa después" es EL consejo
// estándar para webhooks (Meta y Telegram reintentan si tardas), y en un servidor de toda la
// vida funciona. En serverless no.
//
// `waitUntil()` es la API oficial para pedirle a la plataforma que mantenga viva la función
// después de responder. Si no está disponible (fuera de Vercel, en los tests, o si cambia el
// runtime), este helper lo dice —devuelve false— y el llamador ESPERA el trabajo antes de
// contestar: más lento, pero corre. Lo que nunca se vuelve a hacer es dispararlo al vacío.

let waitUntil = null;
try {
  ({ waitUntil } = require("@vercel/functions"));
} catch {
  /* fuera de Vercel: el llamador espera en línea */
}

/**
 * Intenta que `promesa` siga corriendo después de responder.
 * @returns {boolean} true si la plataforma se hizo cargo; false → el llamador debe `await`.
 */
function agendar(promesa) {
  if (typeof waitUntil !== "function") return false;
  try {
    waitUntil(promesa);
    return true;
  } catch {
    // waitUntil revienta fuera de un contexto de request. Se degrada a esperar.
    return false;
  }
}

module.exports = { agendar };
