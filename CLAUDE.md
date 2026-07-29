# CLAUDE.md — minka-webhooks

Endpoints serverless (Vercel) de Minka Digital: **diagnóstico P0**, **onboarding** y **portal**.
CRM = **Odoo** (GHL purgado 2026-07-16; ver `README.md`). Node ≥18, sin build step.

## Deploy — es AUTOMÁTICO (GitHub → Vercel), reconectado 2026-07-29

Un `git push` a `main` **sí despliega solo** a producción — verificado empíricamente el
2026-07-29: el deployment `dpl_9zxrPgN2KfDj4whJ2xGTGWXQ1EuN` se creó a las 20:57:59 UTC, 9
segundos después del push del commit `b900664` (`vercel inspect` confirmó que el alias de
prod `minka-webhooks.vercel.app` apunta exactamente a ese deployment). El proyecto vive bajo
el **team `minkadigital`** en Vercel (Gerónimo lo conectó/transfirió; Project Settings → Git
muestra `geronimoglez/minka-webhooks` conectado).

**Ya no hace falta `npm run deploy` en el flujo normal** — solo si necesitas forzar un deploy
sin pasar por git (poco común):

```powershell
npm run deploy   # = vercel --prod --yes --scope minkadigital
```

Prod alias: <https://minka-webhooks.vercel.app>

Para verificar un deploy: `curl -s -o /dev/null -w "%{http_code}" https://minka-webhooks.vercel.app/api/onboarding` → `405` = vivo (POST-only). Para confirmar QUÉ commit está en prod: `vercel ls minka-webhooks` (lista deployments con edad) + `vercel inspect <url>` (fecha de creación, cotejar contra `git log`).

> Nota para agentes sin sesión de Vercel propia: el conector MCP de Vercel puede no ver este
> proyecto aunque exista (token de cuenta con caché desalineada del lado del conector, no un
> problema real de Vercel) — si `get_project`/`list_projects` no lo encuentra, no asumas que
> no existe. Confirmar con `vercel login` (device-auth, requiere que Gerónimo apruebe una vez
> en el navegador) + `vercel project ls` / `vercel ls minka-webhooks` antes de reportar un
> bloqueo de acceso.

## Arquitectura en 30 segundos (salidas vs webhooks)

- Los endpoints hablan con el CRM por **llamada SALIENTE**: JSON-RPC a Odoo vía
  `lib/crm.js`, autenticando con las credenciales `ODOO_*`. **No es un webhook.**
- OpenRouter (LLM del diagnóstico) y Telegram también son **salientes** (cada uno con su llave).
- **No hay webhooks ENTRANTES hoy.** (`api/ghl.js`, que recibía pushes de GHL, se borró.)
- Un endpoint nuevo que escriba al CRM (p.ej. **minka-brain**) **reusa `lib/crm.js`** —
  `require("../lib/crm")` + `pushLead(...)`. **No necesita webhook ni variables nuevas de CRM.**
- Solo harías un **webhook nuevo** si algo EXTERNO (Odoo, Minka Director, Stripe, un form) te
  **empuja** eventos. En ese caso: endpoint nuevo + secreto propio con nombre (`MINKA_DIRECTOR_WEBHOOK_SECRET`),
  **fail-closed** (rechazar si el secreto está vacío — nunca `if(!SECRET) return true`).

## Env vars (Vercel)

Vivas y necesarias: `ODOO_URL` / `ODOO_DB` / `ODOO_USER` / `ODOO_API_KEY`,
`OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`
(+ opcionales `DIAGNOSTICO_MODEL`, `DIAGNOSTICO_MAIL_*`, `CRM_DRIVER`, `ODOO_WAKE_*`).
Detalle en `.env.example`.
`GHL_*` / `NOTION_*` / `OPENCLAW_*` / `WEBHOOK_SHARED_SECRET`: eliminadas (eran del webhook GHL borrado).

## Tests (sin deps; corren con node a secas)

```powershell
node test/crm_retry.test.js          # wake-retry de Odoo + saneo de PII + escape de =ilike
node test/onboarding_cmd.test.js     # shellSafe del "comando sugerido"
node test/diagnostico_html.test.js   # render del HTML del diagnóstico
node test/diagnostico_llm.test.js    # retry+fallback de modelo, normalizeReport, rate-limit, waitUntil
node test/diagnostico_flow.test.js   # blindaje: el lead entra al CRM ANTES del LLM (FASE 1)
```

## Blindaje anti-pérdida del diagnóstico P0 (FASE 1, 2026-07-29) — no regresar

`api/diagnostico.js` guarda el lead en el CRM **antes** de depender del LLM, y en paralelo (no en
serie) para no pagar latencia. Invariantes que los tests protegen:

- **`crm.pushLead` arranca antes de `callLLM`.** Si el LLM falla, el prospecto ya está en Odoo y
  Telegram avisa igual. Mover el push abajo del LLM es exactamente el bug que se arregló.
- El **enriquecimiento** (nota + adjunto HTML) es trabajo NO crítico: va en segundo plano con
  `waitUntil`, y usa `crm.addLeadNote` (1 RPC) en vez de repetir el `pushLead` completo (~8 RPCs).
- `waitUntil` se implementa **sin dependencias**, con el mismo `Symbol.for("@vercel/request-context")`
  que usa `@vercel/functions`. Si el runtime no lo expone, degrada a `await`. **No instalar el
  paquete**: arrastra 25 deps y obligaría a un `npm install` en el build que hoy no existe.
- `normalizeReport` garantiza que `cuellos`/`quickwins` lleguen al front **siempre como array**.

## El diagnóstico SE LE MANDA al prospecto (FASE 2, 2026-07-29) — no regresar

La página promete *"aquí te mandamos el diagnóstico"*; hasta esta fase nada lo mandaba y el reporte
sólo vivía en la pestaña del navegador. Ahora `api/diagnostico.js` lo envía por correo:

- **Sale por Odoo** (`crm.sendLeadEmail` → `mail.mail` + addon `minka_ses` → AWS SES). Es el mismo
  camino que ya usa `scripts/p0_nurture.py` en producción: **cero credenciales de correo en Vercel**,
  misma identidad verificada en SES, y queda en el **chatter del lead**. No meter aquí un SDK de
  correo ni un segundo remitente: partiría la reputación del dominio.
- **`email_from` va vacío a propósito** → Odoo usa el suyo (`noreply@minkadigital.com`). Cambiarlo
  sin verificar antes la dirección en SES tumba TODO el envío. El `reply_to` (hola@) sí es libre.
- **`send` va con `raise_exception: true`**: por default Odoo marca `state="exception"` y no lanza,
  así que un rechazo de SES sería invisible y volveríamos a prometer un correo que no sale.
- **El correo tiene su propio render** (`renderDiagnosticoEmail`), con tablas y estilos inline. El
  HTML del adjunto usa variables CSS, `@media` y flex/grid: Gmail borra lo primero y Outlook no
  entiende lo segundo. Son dos envases del mismo contenido — al tocar uno, revisar el otro.
- **Es trabajo no crítico**: va en el `waitUntil`, al final del enriquecimiento (lead y adjunto
  primero). Un fallo de correo nunca rompe la respuesta al usuario.
- **Un fallo de correo avisa por Telegram**, no sólo por `console.error`. Los logs de Vercel no los
  mira nadie — por eso este hueco duró meses. No quitar ese aviso.
- **La respuesta 200 lleva `mail: <bool>`** (síncrono: driver odoo + kill-switch encendido). El
  sitio sólo dice "también te lo mandamos a tu correo" cuando viene `true`. Si algún día el envío
  se apaga, la pantalla deja de prometerlo sola.
- **NO se dedupea el envío.** Colgarlo del `deduped` de `attachToLead` parecía gratis pero abría un
  fallo silencioso: si el primer correo falló, el segundo intento se saltaba y el prospecto se
  quedaba sin nada. Cada diagnóstico nuevo se entrega; el techo contra abuso es el rate-limit.

## Privacidad / seguridad (no regresar)

- **Nunca** reflejar al cliente el `detail` crudo de un error de CRM/Odoo (puede eco-ar PII).
  `lib/crm.js` sanea en origen (`odoo-rejected:<Clase>`); `api/onboarding.js` tiene allowlist `safeDetail`.
- Emails a `=ilike` de Odoo van **escapados** (`escLike`) — sin eso, `%@%` casa un contacto arbitrario.
- Valores de usuario en el "comando sugerido" de Telegram van por `shellSafe` (anti copy-paste injection).
