// test/diagnostico_llm.test.js — Tests del blindaje anti-pérdida del diagnóstico P0 (FASE 1).
// Corre: `node test/diagnostico_llm.test.js`. Exit 1 si falla algo. Sin deps: mockea global.fetch.
//
// Cubre:
//  A: callLLM reintenta con el modelo primario ante un 5xx transitorio de OpenRouter.
//  B: si el primario falla 2 veces, la 3ª pasada usa el modelo de FALLBACK (otro proveedor).
//  C: un JSON malformado / reporte incompleto también dispara reintento (antes cortaba con 502).
//  D: callLLM nunca lanza: agotados los intentos devuelve null (el lead ya está salvo).
//  E: normalizeReport blinda al front — `cuellos`/`quickwins` SIEMPRE array, aunque el LLM los omita.
//  F: el rate-limit deja pasar RL_MAX y corta en el siguiente (CGNAT: 15, no 6).
//  G: waitUntil usa el contexto de Vercel si existe y devuelve false si no (→ el caller hace await).
//  H: los logs de fallo del LLM NO filtran PII (ship-review: el SyntaxError de JSON.parse incluye
//     un fragmento del texto — que es el diagnóstico del negocio del prospecto).
//  I: settleWithin devuelve null si la promesa sigue pendiente y no la cancela.

process.env.OPENROUTER_API_KEY = "test-key";
process.env.DIAGNOSTICO_MODEL = "modelo/primario";
process.env.DIAGNOSTICO_MODEL_FALLBACK = "modelo/fallback";
process.env.DIAGNOSTICO_RL_MAX = "15";

const { __test } = require("../api/diagnostico.js");
const { callLLM, normalizeReport, rateLimited, waitUntil, settleWithin, RL_MAX } = __test;

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log(" FAIL  " + label); }
}

const OK_REPORT = {
  resumen: "Un negocio local con flujo de mensajes.",
  cuellos: [{ titulo: "c1", detalle: "d1" }],
  quickwins: [{ titulo: "q1", como: "paso", gratis: true }],
  horas_semana: 8,
  plan: { slug: "respuesta-ia", porque: "porque sí" },
};

// Mock de global.fetch que consume `seq`. Cada item:
//   {status} → respuesta HTTP cruda (p.ej. 429/500)
//   {content} → 200 con el string como content del choice
function mockFetch(seq) {
  const state = { models: [] };
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(opts.body);
    state.models.push(body.model);
    const item = seq[Math.min(state.models.length - 1, seq.length - 1)];
    if (item.status && item.status !== 200) return { ok: false, status: item.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: item.content } }] }) };
  };
  return state;
}

const P = { nombre: "N", negocio: "B", giro: "g", etapa: "e", canal: "c", dolor: "d",
  procesos: "p", volumen: "v", sitio: "" };

const realFetch = global.fetch;
const realLog = console.error;

(async () => {
  console.log("A/B/C/D — callLLM: retry + fallback de modelo");
  console.error = () => {}; // silenciar los console.error esperados de los intentos fallidos

  // A: 500 transitorio → reintenta con el MISMO modelo primario y devuelve el reporte.
  let m = mockFetch([{ status: 500 }, { content: JSON.stringify(OK_REPORT) }]);
  let r = await callLLM(P);
  check(r && r.plan.slug === "respuesta-ia", "A: 500 transitorio → reintento exitoso");
  check(m.models.length === 2 && m.models[0] === "modelo/primario" && m.models[1] === "modelo/primario",
    "A: el reintento usa el modelo primario (" + m.models.join(", ") + ")");

  // B: primario falla 2 veces → 3ª pasada con el fallback.
  m = mockFetch([{ status: 429 }, { status: 500 }, { content: JSON.stringify(OK_REPORT) }]);
  r = await callLLM(P);
  check(!!r, "B: el fallback rescata el diagnóstico");
  check(m.models.length === 3 && m.models[2] === "modelo/fallback",
    "B: la 3ª pasada usa el modelo de fallback (" + m.models.join(", ") + ")");

  // C: JSON malformado y reporte sin `plan` → reintentables (antes: 502 seco).
  m = mockFetch([{ content: "{ esto no es json" }, { content: JSON.stringify({ resumen: "sin plan" }) },
    { content: JSON.stringify(OK_REPORT) }]);
  r = await callLLM(P);
  check(!!r && r.plan.slug === "respuesta-ia", "C: JSON roto + reporte incompleto → reintenta y se recupera");
  check(m.models.length === 3, "C: consumió los 3 intentos");

  // D: todo falla → null, sin lanzar (el handler responde 502 pero el lead ya está guardado).
  m = mockFetch([{ status: 503 }]);
  r = await callLLM(P);
  check(r === null, "D: agotados los intentos devuelve null (no lanza)");
  check(m.models.length === 3, "D: intentó las 3 veces antes de rendirse");

  console.error = realLog;
  global.fetch = realFetch;

  console.log("E — normalizeReport: el front nunca recibe un no-array");
  const partial = normalizeReport({ plan: { slug: "respuesta-ia", porque: "x" }, resumen: "r" });
  check(Array.isArray(partial.cuellos) && partial.cuellos.length === 0, "E: `cuellos` ausente → []");
  check(Array.isArray(partial.quickwins) && partial.quickwins.length === 0, "E: `quickwins` ausente → []");
  check(normalizeReport({ plan: {}, cuellos: "no soy array" }).cuellos.length === 0, "E: `cuellos` string → []");
  check(normalizeReport({ plan: { slug: "s" }, cuellos: [null, { titulo: "t" }] }).cuellos.length === 1,
    "E: entradas basura del array se descartan");
  check(normalizeReport({ resumen: "sin plan" }) === null, "E: sin `plan` → null (dispara reintento)");
  check(normalizeReport(null) === null, "E: null → null");
  const full = normalizeReport(OK_REPORT);
  check(full.cuellos.length === 1 && full.quickwins[0].gratis === true && full.horas_semana === 8,
    "E: un reporte válido pasa intacto");

  console.log("F — rate-limit (CGNAT)");
  check(RL_MAX === 15, "F: RL_MAX = 15 (antes 6)");
  const ip = "203.0.113.7";
  let blocked = null;
  for (let i = 1; i <= RL_MAX + 1; i++) if (rateLimited(ip) && blocked === null) blocked = i;
  check(blocked === RL_MAX + 1, `F: bloquea en el intento ${RL_MAX + 1} (fue ${blocked})`);
  check(rateLimited("198.51.100.9") === false, "F: otra IP no queda contaminada");

  console.log("G — waitUntil sin dependencia");
  check(waitUntil(Promise.resolve()) === false, "G: sin contexto de Vercel → false (el caller hace await)");
  let captured = null;
  globalThis[Symbol.for("@vercel/request-context")] = { get: () => ({ waitUntil: (p) => { captured = p; } }) };
  const pr = Promise.resolve("x");
  check(waitUntil(pr) === true && captured === pr, "G: con contexto → delega la promesa y devuelve true");
  globalThis[Symbol.for("@vercel/request-context")] = { get: () => { throw new Error("boom"); } };
  check(waitUntil(Promise.resolve()) === false, "G: un contexto que lanza degrada a false, no revienta");
  delete globalThis[Symbol.for("@vercel/request-context")];

  console.log("H — los logs de fallo del LLM no filtran PII");
  // El LLM devuelve un JSON roto que contiene datos del prospecto. JSON.parse lanzaría un
  // SyntaxError cuyo mensaje incluye un fragmento de ese texto → NO debe llegar a los logs.
  // Fixture elegido a propósito: SIN la guarda, V8 produce
  //   `Unexpected token 'T', ..."resumen": Taqueria D"... is not valid JSON`
  // — es decir, el nombre del negocio del prospecto dentro del mensaje de error.
  const BROKEN = '{"resumen": Taqueria Dona Chuy tel 3312345678}';
  let leaks = false;
  try { JSON.parse(BROKEN); } catch (e) { leaks = e.message.includes("Taqueria"); }
  check(leaks, "H: (premisa) el SyntaxError de V8 sí filtraría el nombre del negocio");

  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  mockFetch([{ content: BROKEN }]);
  r = await callLLM(P);
  console.error = realLog;
  global.fetch = realFetch;
  check(r === null, "H: el JSON roto agota los intentos y devuelve null");
  check(logged.length === 3, "H: se logueó un intento fallido por pasada");
  const blob = logged.join(" | ");
  check(!blob.includes("Taqueria") && !blob.includes("Chuy") && !blob.includes("3312345678"),
    "H: NINGÚN dato del prospecto aparece en los logs");
  check(blob.includes("llm-json-invalido"), "H: sí queda el token diagnóstico (`llm-json-invalido`)");

  console.log("I — settleWithin");
  const slow = new Promise((res) => setTimeout(() => res("tarde"), 200));
  check(await settleWithin(slow, 20) === null, "I: promesa pendiente → null (no la cancela)");
  check(await slow === "tarde", "I: y la promesa original sigue viva y resuelve después");
  check(await settleWithin(Promise.resolve("ya"), 500) === "ya", "I: si resuelve a tiempo, pasa el valor");
  check(await settleWithin(Promise.resolve("x"), 0) === null, "I: presupuesto agotado → null inmediato");

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
