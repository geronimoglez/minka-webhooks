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
const aviso = require("./aviso");

const money = (centavos) => "$" + (Number(centavos) / 100).toLocaleString("es-MX") + " MXN";

// Recupera una sesión de Stripe y comprueba que NOS PERTENECE, antes de que nadie use su contenido.
//
// Es una función aparte porque hay dos caminos que necesitan exactamente esta validación —
// confirmar un pago y volver de una cancelación— y cuando cada uno la escribía por su cuenta, uno
// de los dos se quedó sin el chequeo de tenant. Con la cuenta de Stripe compartida entre clientes
// de Minka, ese hueco dejaba que cualquier id de sesión ajeno produjera un token firmado para un
// lead de ESTA base (ship-review 2026-07-30).
//
// → { ok:true, session } | { ok:false, reason }
async function fetchOwnSession(sessionId, cfg) {
  if (!stripe.isSessionId(sessionId)) return { ok: false, reason: "bad-session-id" };

  let s;
  try {
    s = await stripe.retrieveSession(sessionId);
  } catch (e) {
    return { ok: false, reason: String(e.message || "stripe-error").slice(0, 60) };
  }

  // Una sesión de prueba no puede tocar datos de producción (ni al revés). Si no coinciden, es que
  // alguien apuntó el webhook de un modo al despliegue del otro.
  if (Boolean(s.livemode) !== stripe.isLive()) return { ok: false, reason: "livemode-mismatch" };

  // El tenant de la sesión TIENE que ser el que este despliegue atiende: una sesión de otro cliente
  // no puede terminar tocando esta base de datos ni emitiendo un token para uno de sus leads.
  if (String((s.metadata && s.metadata.tenant) || "") !== cfg.tenant) {
    return { ok: false, reason: "tenant-mismatch" };
  }

  const leadId = Number(s.metadata && s.metadata.leadId);
  if (!Number.isSafeInteger(leadId) || leadId <= 0) return { ok: false, reason: "no-lead" };

  return { ok: true, session: s, leadId };
}

// confirm(sessionId, cfg) → { ok, paid, leadId?, deduped?, reason? }
// `reason` es siempre un token corto sin PII.
async function confirm(sessionId, cfg) {
  const own = await fetchOwnSession(sessionId, cfg);
  if (!own.ok) return { ok: false, paid: false, reason: own.reason };
  const s = own.session;
  const leadId = own.leadId;

  if (s.payment_status !== "paid") {
    return { ok: true, paid: false, leadId, reason: s.payment_status || "unpaid" };
  }

  const pagado = money(s.amount_total);
  const esperado = cfg.apartadoMxn * 100;
  // El monto se registra tal como Stripe lo cobró. Si no coincide con el configurado (porque la
  // variable cambió entre que se creó la sesión y que se pagó), se anota la diferencia en vez de
  // rechazar un pago que ya ocurrió.
  const avisoMonto = s.amount_total !== esperado ? ` ⚠️ (configurado hoy: ${money(esperado)})` : "";

  const nota = [
    `💳 APARTADO PAGADO — ${pagado}${avisoMonto}`,
    "",
    `Sesión de Stripe: ${s.id}`,
    `Estado: ${s.payment_status} · ${new Date().toISOString()}`,
    "",
    "Se abona al precio del pase. No reembolsable si la persona decide no asistir.",
    "Cobrado por Minka Digital (la pasarela es de la agencia).",
  ].join("\n");

  const noted = await crm.noteOnce(leadId, { tenant: cfg.tenant, body: nota, mark: s.id });
  if (!noted.ok) {
    // El dinero YA se cobró y no se pudo dejar constancia. Es el caso que hay que poder depurar a
    // las 3 de la mañana, así que se registra y se avisa — el webhook reintentará.
    console.error(`[apartado] cobro sin registrar · lead ${leadId} · sesión ${s.id} · ${noted.detail || "crm-error"}`);
    await aviso.enviar(
      `🚨 COBRO SIN REGISTRAR — ${pagado}\nLead #${leadId} · ${cfg.tenant}\n🧾 ${s.id}\n` +
      `El cargo existe en Stripe pero no se pudo escribir en el CRM. Stripe reintentará el webhook.`,
      "apartado");
    return { ok: false, paid: true, leadId, reason: "crm-write-failed" };
  }
  if (noted.deduped) return { ok: true, paid: true, leadId, deduped: true };

  const tagged = await crm.tagLead(leadId, ["apartado-pagado"], { tenant: cfg.tenant });
  if (!tagged.ok) console.error(`[apartado] no se pudo etiquetar el lead ${leadId}: ${tagged.detail || "crm-error"}`);

  // Aviso mínimo: el expediente completo ya está en el CRM. No se manda el correo que capturó
  // Stripe — es un dato personal más, en un destinatario más, que aquí no aporta nada.
  await aviso.enviar(
    `💳 APARTADO PAGADO — ${pagado}${avisoMonto}\nLead #${leadId} · ${cfg.tenant}\n🧾 ${s.id}`,
    "apartado");

  return { ok: true, paid: true, leadId, deduped: false };
}

module.exports = { confirm, fetchOwnSession };
