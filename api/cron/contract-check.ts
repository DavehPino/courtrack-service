// GET /api/cron/contract-check → ContractReport. Cron semanal (viernes 12:00 UTC, ver vercel.json): revisa el contrato
// de CourtTrack con los últimos partidos jugados de cada liga activa. Si falla, avisa por email (Resend). Responde 200
// aunque el contrato falle (el cron funcionó; el resultado va en `ok`); solo un error del propio chequeo devuelve 5xx.
// Auth: `Authorization: Bearer <CRON_SECRET>` (lo envía Vercel Cron) o `<SYNC_SECRET>` para lanzarlo a mano.
// `?notify=0` revisa sin enviar el email; `?last=N` cambia cuántos partidos por liga (4 por defecto).
import { requireCronOrSecret } from '../_lib/auth.js'
import { checkLeagues, type ContractReport } from '../_lib/contractCheck.js'
import { env } from '../_lib/env.js'
import { handle, noStore } from '../_lib/http.js'
import { listActiveLeagueTargets } from '../_lib/leagues.js'

const MAX_LISTED = 20

const summary = (report: ContractReport) =>
  [
    `courtrack-service: el contrato con CourtTrack falló (${report.failures.length} fallas en ${report.checked.length} partidos).`,
    ...report.failures.slice(0, MAX_LISTED).map((failure) => `• ${failure}`),
    report.failures.length > MAX_LISTED ? `… y ${report.failures.length - MAX_LISTED} más` : '',
  ]
    .filter(Boolean)
    .join('\n')

/** Envía el aviso por Resend. Devuelve false si no está configurado o si el envío falla (no rompe el cron). */
async function notify(report: ContractReport): Promise<boolean> {
  if (!env.resendApiKey || !env.alertEmailTo) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.alertEmailFrom,
      to: env.alertEmailTo.split(',').map((address) => address.trim()).filter(Boolean),
      subject: `courtrack-service: el contrato con CourtTrack falló (${report.failures.length} fallas)`,
      text: `${summary(report)}

Siguiente paso: /courtrack-repair en courtrack-service (docs/handoff-courtrack.md).`,
    }),
  }).catch((err) => {
    console.error('email', err)
    return null
  })
  if (res && !res.ok) console.error('email', res.status, await res.text())
  return Boolean(res?.ok)
}

export const GET = handle(async (request) => {
  requireCronOrSecret(request)
  const params = new URL(request.url).searchParams
  const last = Math.min(Math.max(Number(params.get('last')) || 4, 1), 10)

  const targets = await listActiveLeagueTargets()
  const report = await checkLeagues(targets, last)
  if (!targets.length) report.warnings.push('no hay ligas activas que revisar')
  console.log(JSON.stringify({ event: 'contract-check', ok: report.ok, checked: report.checked.length, failures: report.failures, warnings: report.warnings }))

  const notified = !report.ok && params.get('notify') !== '0' ? await notify(report) : false
  return noStore({ ...report, leagues: targets.length, notified })
})
