// Clasificador + redactor del copiloto de comentarios (modo AUDIENCIA).
//
// Doctrina completa: repo MinkaDigital-mktAIDir → docs/instagram-moderacion-copiloto.md
// §MODO AUDIENCIA y el banco en workspace-director/outputs/estrategia-contenido/.
//
// La regla que ordena todo: en un hilo NO le escribes al que comentó, le escribes al ~99% que
// lee y no comenta. De ahí: conceder primero, matizar después, cerrar con pregunta, y nunca
// responder dos veces al mismo troll.

const MODELO = process.env.IG_COPILOTO_MODEL || "deepseek/deepseek-v4-flash";

/**
 * Compuerta de automatización: automático SOLO donde el downside es cero.
 *  - auto:     se publica sin aprobación. Si sale mediocre, no pasa nada.
 *  - borrador: se redacta y espera el tap de Gerónimo (toca dinero, giro o competencia).
 *  - manual:   ni siquiera se redacta; es un lead o un tema delicado.
 */
const ARQUETIPOS = {
  elogio:      { modo: "auto",     etiqueta: "Elogio simple" },
  boba:        { modo: "auto",     etiqueta: "Pregunta boba / fuera de tema" },
  spam:        { modo: "auto",     etiqueta: "Spam o insulto", accion: "ocultar" },
  esceptico:   { modo: "borrador", etiqueta: "Escéptico de giro ⭐" },
  precio:      { modo: "borrador", etiqueta: "Objeción de precio" },
  comparativa: { modo: "borrador", etiqueta: "Comparativa con otra herramienta" },
  yausoia:     { modo: "borrador", etiqueta: "«Yo ya uso ChatGPT»" },
  miedo:       { modo: "manual",   etiqueta: "Miedo al reemplazo" },
  lead:        { modo: "manual",   etiqueta: "Pregunta comercial (ES UN LEAD)" },
  troll:       { modo: "manual",   etiqueta: "Troll" },
};

const SISTEMA = `Eres el copiloto de comentarios de @minka.one, la cuenta de Minka Digital
(automatización de atención y contenido con IA para PyMEs en México). Escribes como Gerónimo
González, el fundador: directo, cálido, con humor seco, sin jerga y sin vender de más.

REGLA MADRE: en un hilo no le escribes al que comentó, le escribes al 99% que lee y no comenta.
Nunca ganes la discusión: deja bien parado a quien te cuestiona.

CÓMO SE RESPONDE:
- Concede primero, matiza después ("tienes razón en X… y además pasa Y").
- Cierra con una pregunta siempre que se pueda, para que el hilo siga vivo.
- Máximo 2 frases. En Instagram nadie lee párrafos en comentarios.
- Español de México, tuteo (tú/tienes), NUNCA voseo (nada de "tenés"/"podés").
- Cero emojis salvo que el comentario venga con humor.
- Nunca ofrezcas descuentos. Nunca hables mal de un competidor. Nunca inventes cifras.
- Si el comentario dice que algo no le aplica, dile con honestidad EN QUÉ CASO no lo necesita.
  Esa honestidad es lo que nos separa de los que solo venden.

ARQUETIPOS: elogio, boba, esceptico, precio, comparativa, yausoia, miedo, lead, troll, spam.

Devuelve SOLO JSON válido:
{"arquetipo":"<uno>","confianza":0.0-1.0,"borrador":"<respuesta o null si arquetipo es miedo/lead/troll/spam>","dolor":"<la frase textual del comentarista que revela un dolor concreto, o null>","giro":"<giro de negocio si se deduce, o null>"}`;

/**
 * Clasifica y redacta. Ante CUALQUIER falla, degrada a manual: es fail-closed a propósito —
 * más vale que Gerónimo lo lea a que salga una respuesta equivocada con su cara.
 */
async function analizar(texto, contextoPieza) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { arquetipo: "lead", confianza: 0, borrador: null, error: "sin OPENROUTER_API_KEY" };

  const user = `PIEZA donde comentaron: ${String(contextoPieza || "(sin contexto)").slice(0, 400)}
COMENTARIO: ${String(texto).slice(0, 800)}`;

  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODELO,
        messages: [{ role: "system", content: SISTEMA }, { role: "user", content: user }],
        temperature: 0.6,
        max_tokens: 400,
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) throw new Error(`openrouter ${r.status}`);
    const d = await r.json();
    const out = JSON.parse(d.choices[0].message.content);
    if (!ARQUETIPOS[out.arquetipo]) out.arquetipo = "lead"; // desconocido → lo ve un humano
    return out;
  } catch (e) {
    return { arquetipo: "lead", confianza: 0, borrador: null, error: String(e.message || e) };
  }
}

/**
 * Decide qué hacer. La confianza baja SIEMPRE escala a manual, nunca al revés:
 * ante la duda, que lo lea un humano.
 */
function decidir(analisis) {
  const meta = ARQUETIPOS[analisis.arquetipo] || ARQUETIPOS.lead;
  const conf = Number(analisis.confianza) || 0;
  let modo = meta.modo;
  if (modo === "auto" && conf < 0.75) modo = "borrador";
  if (modo === "borrador" && conf < 0.4) modo = "manual";
  if (!analisis.borrador && modo !== "manual" && meta.accion !== "ocultar") modo = "manual";
  return { modo, etiqueta: meta.etiqueta, accion: meta.accion || null };
}

module.exports = { ARQUETIPOS, analizar, decidir, MODELO };
