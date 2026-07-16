// test/crm_retry.test.js — Tests del wake-retry de crm.js (resiliencia al cold-start de Railway).
// Corre: `node test/crm_retry.test.js`. Exit 1 si falla algo. Sin deps: mockea global.fetch.
//
// Cubre los hallazgos de ship-review 2026-07-13:
//  A: el wake (retries>0) reintenta ante error de red y luego devuelve el result.
//  B: retries=0 (create/write) NO reintenta → 1 solo intento (sin duplicar registros).
//  C: el presupuesto total del wake (ODOO_WAKE_MAX_MS) corta el retry (no revienta el maxDuration).
//  D: un error de negocio de Odoo (data.error) NO se reintenta.
//  E: un 5xx transitorio durante el wake sí se reintenta.

// Env ANTES de require: crm.js lee los tunables a load-time. Backoff/presupuesto chicos → test rápido.
process.env.ODOO_URL = "https://odoo.example.com";
process.env.ODOO_DB = "db";
process.env.ODOO_USER = "u";
process.env.ODOO_API_KEY = "k";
process.env.CRM_DRIVER = "odoo";
process.env.ODOO_WAKE_RETRIES = "2";
process.env.ODOO_WAKE_BACKOFF_MS = "5";
process.env.ODOO_WAKE_MAX_MS = "500";

const CRM_PATH = require.resolve("../lib/crm.js");
let { odooRpc, pushLead, findByEmail, escLike, __resetUid } = require(CRM_PATH);

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log(" FAIL  " + label); }
}

// Instala un mock de global.fetch que consume `seq`. Cada item:
//   function  → se invoca (puede lanzar, simula error de red/abort)
//   {status?, result?, error?} → respuesta con r.status y r.json()
function mockFetch(seq) {
  const state = { n: 0, bodies: [] };
  global.fetch = async (_url, opts) => {
    state.bodies.push(opts && opts.body);
    const item = seq[Math.min(state.n, seq.length - 1)];
    state.n++;
    if (typeof item === "function") return item();
    const status = item.status ?? 200;
    return { status, json: async () => (item.error ? { error: item.error } : { result: item.result }) };
  };
  return state;
}

async function main() {
  const boom = () => { throw new Error("ECONNREFUSED"); };

  // A: wake reintenta ante error de red y luego devuelve el result
  {
    const st = mockFetch([boom, boom, { result: 42 }]);
    const r = await odooRpc("common", "authenticate", [], { retries: 2 });
    check(r === 42, "A: wake reintenta 2× y devuelve el result");
    check(st.n === 3, "A: exactamente 3 fetch (2 fallos + 1 ok)");
  }

  // B: retries=0 (create/write) NO reintenta → un fallo se propaga en el 1er intento
  {
    const st = mockFetch([boom, { result: 1 }]);
    let threw = false;
    try { await odooRpc("object", "execute_kw", []); } catch { threw = true; }
    check(threw, "B: retries=0 propaga el error (no reintenta)");
    check(st.n === 1, "B: exactamente 1 fetch (single-shot → sin duplicados)");
  }

  // D: error de negocio (data.error) NO se reintenta Y se sanea. NO propaga data.error.data.message
  //    (que puede eco-ar PII del prospecto — ship-review 2026-07-13); sólo la clase de excepción.
  {
    const st = mockFetch([{ error: { data: {
      name: "odoo.exceptions.ValidationError",
      message: 'Teléfono +52 33 1234 5678 de "Juan Pérez" (juan@x.com) inválido.',
    } } }, { result: 9 }]);
    let msg = "";
    try { await odooRpc("object", "execute_kw", [], { retries: 2 }); } catch (e) { msg = e.message; }
    check(msg === "odoo-rejected:ValidationError", "D: error de negocio propaga sólo la clase (saneado)");
    check(!/Juan Pérez|juan@x\.com|1234 5678/.test(msg), "D: el mensaje propagado NO contiene PII");
    check(st.n === 1, "D: error de negocio NO se reintenta (1 fetch)");
  }

  // E: 5xx transitorio durante el wake se reintenta
  {
    const st = mockFetch([{ status: 503 }, { status: 502 }, { status: 200, result: 7 }]);
    const r = await odooRpc("common", "authenticate", [], { retries: 2 });
    check(r === 7, "E: 5xx se reintenta y luego devuelve el result");
    check(st.n === 3, "E: 3 fetch (2× 5xx + 1 ok)");
  }

  // F: regresión de PRIVACIDAD (ship-review 2026-07-13) — end-to-end por pushLead. Ante un error de
  //    validación de Odoo cuyo mensaje eco-a PII, el `detail` resultante (que onboarding.js devuelve
  //    en el HTTP y diagnostico.js loguea) NO debe contener email/teléfono/nombre del prospecto.
  {
    __resetUid();
    const PII = { nombre: "Ana Gómez", email: "ana.gomez@gmail.com", whatsapp: "+52 33 9876 5432", negocio: "Estética Luz" };
    mockFetch([
      { result: 7 },   // authenticate → uid
      { result: [] },  // res.partner search → sin match (fuerza create)
      { error: { data: {   // res.partner create → ValidationError con PII interpolada
        name: "odoo.exceptions.ValidationError",
        message: `Teléfono ${PII.whatsapp} de "${PII.nombre}" (${PII.email}) inválido.`,
      } } },
    ]);
    const r = await pushLead(PII, { tags: ["diagnostico-p0"], note: "x" });
    const anyPII = [PII.nombre, PII.email, PII.whatsapp].some((v) => String(r.detail).includes(v));
    check(r.ok === false, "F: pushLead reporta fallo honesto (ok:false)");
    check(r.detail === "odoo-rejected:ValidationError", "F: detail es el token saneado");
    check(!anyPII, "F: detail NO filtra PII del prospecto (nombre/email/teléfono)");
  }

  // H: escLike escapa los comodines de SQL LIKE (% _ \) para el operador `=ilike` de Odoo
  //    (ship-review 2026-07-16). Sin esto un email "%@%" casaría un contacto ARBITRARIO.
  {
    check(escLike("%@%") === "\\%@\\%", "H: escapa % (evita casar un contacto arbitrario)");
    check(escLike("john_doe@x.com") === "john\\_doe@x.com", "H: escapa _ (email literal, no comodín)");
    check(escLike("a\\b") === "a\\\\b", "H: escapa la backslash");
    check(escLike("juan@x.com") === "juan@x.com", "H: email normal es no-op");
  }

  // G: end-to-end — findByEmail("%@%") debe mandar a Odoo el patrón ESCAPADO en el dominio `=ilike`,
  //    no el crudo. Prueba que el fix está cableado en el sink real (no sólo el helper).
  {
    __resetUid();
    const st = mockFetch([{ result: 5 }, { result: [] }]); // authenticate uid, luego res.partner search
    const r = await findByEmail("%@%");
    check(r.found === false, "G: sin match → found:false (no casa un contacto arbitrario)");
    const domain = JSON.parse(st.bodies[1]).params.args[5]; // [[["email","=ilike", <patrón>]]]
    const pattern = domain[0][0][2];
    check(pattern === "\\%@\\%", "G: el dominio =ilike lleva el patrón escapado");
    check(!/(^|[^\\])%/.test(pattern), "G: no queda ningún % sin escapar en el patrón");
  }

  // C: presupuesto total agotado → el retry se corta (re-require con MAX chico y backoff que lo excede)
  {
    delete require.cache[CRM_PATH];
    process.env.ODOO_WAKE_MAX_MS = "1";       // presupuesto casi nulo
    process.env.ODOO_WAKE_BACKOFF_MS = "50";  // el backoff excede el presupuesto → no debe reintentar
    const crm2 = require(CRM_PATH);
    const st = mockFetch([boom, boom, boom]);
    let threw = false;
    try { await crm2.odooRpc("common", "authenticate", [], { retries: 2 }); } catch { threw = true; }
    check(threw, "C: wake agota el presupuesto → propaga error");
    check(st.n === 1, "C: presupuesto chico corta el retry (1 fetch pese a retries=2)");
  }

  console.log(`\n${pass} ok, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}
main();
