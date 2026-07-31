// lib/apartado.js — confirmación del apartado, en UN solo lugar.
//
// El pago nos llega por dos caminos independientes y los dos terminan aquí:
//   1. el navegador vuelve de Stripe a /postulacion/pagado  (rápido, pero se pierde si la persona
//      cierra la pestaña antes de que Stripe la redirija)
//   2. el webhook de Stripe                                  (llega igual aunque nadie vuelva)
//
// Tener los dos no es redundancia inútil: con sólo el retorno, un pago real podría no quedar nunca
// registrado en el CRM; con sólo el webhook, la persona vería "no pagado" durante unos segundos.
// Por eso esta función es IDEMPOTENTE: la marca de dedup es el id de la sesión de Stripe, así que
// el primero que llegue escribe y el segundo no duplica ni la nota ni el aviso.
//
// LA REGLA: no se confía en NADA de lo que llegue por la petición salvo el id de la sesión, y ese
// id se vuelve a consultar contra Stripe con la llave secreta. Ni el monto, ni el estado del pago,
// ni a qué lead pertenece salen del navegador ni del cuerpo del webhook: salen de Stripe.

const crm = require("./crm");
const stripe = require("./stripe");

const TG_TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = () => process.env.TELEGRAM_CHAT_ID || "";

const money = (centavos) => "$" + (Number(centavos) / 100).toLocaleString("es-MX") + " MXN";

// confirm(sessionId, cfg) → { ok, paid, leadId?, deduped?, reason? }
// `reason` es siempre un token corto sin PII.
async function confirm(sessionId, cfg) {
  if (!stripe.isSessionId(sessionId)) return { ok: false, paid: false, reason: "bad-session-id" };

  let s;
  try {
    s = await stripe.retrieveSession(sessionId);
  } catch (e) {
    return { ok: false, paid: false, reason: String(e.message || "stripe-error").slice(0, 60) };
  }

  // Una sesión de prueba no puede tocar datos de producción (ni al revés). Si no coinciden, es que
  // alguien apuntó el webhook de un modo al despliegue del otro.
  if (Boolean(s.livemode) !== stripe.isLive()) return { ok: false, paid: false, reason: "livemode-mismatch" };

  if (s.payment_status !== "paid") {
    return { ok: true, paid: false, reason: s.payment_status || "unpaid" };
  }

  const leadId = Number(s.metadata && s.metadata.leadId);
  if (!Number.isSafeInteger(leadId) || leadId <= 0) return { ok: false, paid: true, reason: "no-lead" };

  // El tenant de la sesión TIENE que ser el que este despliegue atiende. Si no coincide, no se
  // escribe: una sesión de otro cliente no puede terminar tocando esta base de datos.
  if (String(s.metadata.tenant || "") !== cfg.tenant) {
    return { ok: false, paid: true, reason: "tenant-mismatch" };
  }

  const pagado = money(s.amount_total);
  const esperado = cfg.apartadoMxn * 100;
  // El monto se registra tal como Stripe lo cobró. Si no coincide con el configurado (porque la
  // variable cambió entre que se creó la sesión y que se pagó), se anota la diferencia en vez de
  // rechazar un pago que ya ocurrió.
  const aviso = s.amount_total !== esperado ? ` ⚠️ (configurado hoy: ${money(esperado)})` : "";

  const nota = [
    `💳 APARTADO PAGADO — ${pagado}${aviso}`,
    "",
    `Sesión de Stripe: ${s.id}`,
    `Estado: ${s.payment_status} · ${new Date().toISOString()}`,
    "",
    "Se abona al precio del pase. No reembolsable si la persona decide no asistir.",
    "Cobrado por Minka Digital (la pasarela es de la agencia).",
  ].join("\n");

  const noted = await crm.noteOnce(leadId, { tenant: cfg.tenant, body: nota, mark: s.id });
  if (!noted.ok) return { ok: false, paid: true, leadId, reason: "crm-write-failed" };
  if (noted.deduped) return { ok: true, paid: true, leadId, deduped: true };

  await crm.tagLead(leadId, ["apartado-pagado"], { tenant: cfg.tenant });

  if (TG_TOKEN() && TG_CHAT()) {
    const text = [
      `💳 APARTADO PAGADO — ${pagado}${aviso}`,
      `Lead #${leadId} · ${cfg.tenant}`,
      s.customer_details && s.customer_details.email ? `📧 ${s.customer_details.email}` : "",
      `🧾 ${s.id}`,
    ].filter(Boolean).join("\n");
    await fetch(`https://api.telegram.org/bot${TG_TOKEN()}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT(), text }),
    }).catch(() => {});
  }

  return { ok: true, paid: true, leadId, deduped: false };
}

module.exports = { confirm };
