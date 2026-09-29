// CLI del chequeo de contrato contra CourtTrack (la lógica y las invariantes viven en api/_lib/contractCheck.ts).
// Sale con código 1 si algo no cuadra; es el primer paso del handoff de docs/handoff-courtrack.md.
//   npm run check:courtrack                                   últimos 4 partidos jugados de la liga 605 (PODIO)
//   npm run check:courtrack -- --cliente 5 --liga 605 --last 8 --partido 62526,61930
import { checkLeagues, checkMatches } from '../api/_lib/contractCheck.js'
import { HttpError } from '../api/_lib/http.js'

const argv = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

const idCliente = Number(option('--cliente') ?? 5)
const ligaId = Number(option('--liga') ?? 605)
const last = Number(option('--last') ?? 4)
const explicitIds = (option('--partido') ?? '').split(',').map(Number).filter(Boolean)

async function main() {
  const report = explicitIds.length
    ? await checkMatches(explicitIds, console.log)
    : await checkLeagues([{ idCliente, ligaId }], last, console.log)
  for (const message of report.warnings) console.warn(`AVISO  ${message}`)
  for (const message of report.failures) console.error(`FALLA  ${message}`)
  console.log(report.ok ? '\nContrato con CourtTrack OK.' : `\n${report.failures.length} fallas: el contrato con CourtTrack cambió.`)
  process.exit(report.ok ? 0 : 1)
}

main().catch((err) => {
  console.error(err instanceof HttpError ? `${err.code}: ${err.message} ${JSON.stringify(err.details ?? '')}` : err)
  process.exit(1)
})
