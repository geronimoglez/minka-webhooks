// lib/evento.js — configuración del embudo de "Íconos de la Belleza · Carreras de Éxito IV".
//
// Todo lo que Juanelo puede querer cambiar sin tocar código vive aquí, leído de env en cada
// invocación (no a load-time) para que un cambio en Vercel aplique sin redeploy del código.

const num = (name, def, lo, hi) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.trunc(v))) : def;
};

function config() {
  return {
    // Base de datos del cliente en el Odoo multi-tenant de Minka (ver lib/crm.js).
    tenant: process.env.EVENTO_CRM_TENANT || "juanelo",

    // Apartado en PESOS enteros. Configurable: Juanelo puede subirlo sin que toquemos código.
    // Tope alto por seguridad: una env var mal escrita no puede convertirse en un cargo absurdo.
    apartadoMxn: num("EVENTO_APARTADO_MXN", 100, 1, 20000),

    // Extra opcional del domingo (viaje a Tequila) — ya confirmado y publicado en la landing.
    extraTequilaMxn: num("EVENTO_EXTRA_TEQUILA_MXN", 1000, 0, 20000),

    lugares: num("EVENTO_LUGARES", 50, 1, 5000),

    // ¿Se puede cobrar en línea hoy? Si Stripe no está configurado, la pantalla de gracias NO
    // muestra el botón de pago: prefiere mandar a WhatsApp antes que ofrecer un botón que lleva a
    // una página de error. Así el embudo puede salir a capturar postulaciones aunque la cuenta de
    // Stripe todavía no exista.
    pagoEnLinea: Boolean(process.env.STRIPE_SECRET_KEY),

    // WhatsApp de atención (mismo número que la landing).
    whatsapp: (process.env.EVENTO_WHATSAPP || "523314192737").replace(/\D/g, ""),

    // Origen público del embudo. Se usa para construir las URLs de retorno de Stripe.
    origin: (process.env.EVENTO_ORIGIN || "https://carrerasdeexito.com").replace(/\/+$/, ""),

    // Pendientes de Juanelo: mientras estén vacíos la página muestra "por confirmar" en vez de
    // inventar un dato. Se llenan por env var cuando los mande.
    fechaSede: process.env.EVENTO_FECHA_SEDE || "",
    precioPase: process.env.EVENTO_PRECIO_PASE || "",
    tiempoRespuesta: process.env.EVENTO_TIEMPO_RESPUESTA || "",
  };
}

module.exports = { config };
