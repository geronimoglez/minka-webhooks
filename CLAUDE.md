# CLAUDE.md — minka-webhooks

Endpoints serverless (Vercel) de Minka Digital: **diagnóstico P0**, **onboarding** y **portal**.
CRM = **Odoo** (GHL purgado 2026-07-16; ver `README.md`). Node ≥18, sin build step.

## ⚠️ Deploy — es MANUAL (no hay auto-deploy)

Este proyecto **NO tiene conectado el auto-deploy de GitHub → Vercel**. Un `git push` a
`main` **NO despliega nada** a producción. El deploy es manual, con la CLI de Vercel:

```powershell
npm run deploy   # = vercel --prod --yes --scope geronimoglezs-projects
```

Prod alias: <https://minka-webhooks.vercel.app>

> Contexto: el auto-deploy GitHub→Vercel se complicó una vez y se dejó desconectado a
> propósito. Como este repo es de un solo proyecto, se podría reconectar directo si algún
> día se quiere (pendiente, no urgente). Mientras tanto: **siempre `npm run deploy`**.

Para verificar un deploy: `curl -s -o /dev/null -w "%{http_code}" https://minka-webhooks.vercel.app/api/onboarding` → `405` = vivo (POST-only).

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
(+ opcionales `DIAGNOSTICO_MODEL`, `CRM_DRIVER`, `ODOO_WAKE_*`). Detalle en `.env.example`.
`GHL_*` / `NOTION_*` / `OPENCLAW_*` / `WEBHOOK_SHARED_SECRET`: eliminadas (eran del webhook GHL borrado).

## Tests (sin deps; corren con node a secas)

```powershell
node test/crm_retry.test.js         # wake-retry de Odoo + saneo de PII + escape de =ilike
node test/onboarding_cmd.test.js    # shellSafe del "comando sugerido"
node test/diagnostico_html.test.js  # render del HTML del diagnóstico
```

## Privacidad / seguridad (no regresar)

- **Nunca** reflejar al cliente el `detail` crudo de un error de CRM/Odoo (puede eco-ar PII).
  `lib/crm.js` sanea en origen (`odoo-rejected:<Clase>`); `api/onboarding.js` tiene allowlist `safeDetail`.
- Emails a `=ilike` de Odoo van **escapados** (`escLike`) — sin eso, `%@%` casa un contacto arbitrario.
- Valores de usuario en el "comando sugerido" de Telegram van por `shellSafe` (anti copy-paste injection).
