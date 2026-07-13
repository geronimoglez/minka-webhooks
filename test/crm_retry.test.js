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
let { odooRpc } = require(CRM_PATH);

let pass = 0, fail = 0;
function check(cond, label) {
  if (cond) { pass++; console.log("  ok   " + label); }
  else { fail++; console.log(" FAIL  " + label); }
}

// Instala un mock de global.fetch que consume `seq`. Cada item:
//   function  → se invoca (puede lanzar, simula error de red/abort)
//   {status?, result?, error?} → respuesta con r.status y r.json()
function mockFetch(seq) {
  const state = { n: 0 };
  global.fetch = async () => {
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

  // D: error de negocio (data.error) NO se reintenta
  {
    const st = mockFetch([{ error: { message: "validation-failed" } }, { result: 9 }]);
    let msg = "";
    try { await odooRpc("object", "execute_kw", [], { retries: 2 }); } catch (e) { msg = e.message; }
    check(msg === "validation-failed", "D: error de negocio se propaga con su mensaje");
    check(st.n === 1, "D: error de negocio NO se reintenta (1 fetch)");
  }

  // E: 5xx transitorio durante el wake se reintenta
  {
    const st = mockFetch([{ status: 503 }, { status: 502 }, { status: 200, result: 7 }]);
    const r = await odooRpc("common", "authenticate", [], { retries: 2 });
    check(r === 7, "E: 5xx se reintenta y luego devuelve el result");
    check(st.n === 3, "E: 3 fetch (2× 5xx + 1 ok)");
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
