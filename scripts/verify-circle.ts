/**
 * Read-only check of every Circle integration against live Arc Mainnet and Circle's own registry and API.
 * No keys, no signing, no transactions. Exits with code 1 if any check fails.
 */
import { runCircleChecks } from '@/circle/verify'

const checks = await runCircleChecks()
for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  [${check.group}] ${check.label}\n      ${check.detail}`)
const failed = checks.filter((check) => !check.ok)
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
