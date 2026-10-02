import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Best, FinishOn, Finished, Run } from '../types'

const run = atom({ plugin: 'speedrun-splits', key: 'run' } as const, null)
const now = atom({ plugin: 'speedrun-splits', key: 'now' } as const, 0)
const hidden = atom({ plugin: 'speedrun-splits', key: 'hidden' } as const, false)
const finishOn = atom({ plugin: 'speedrun-splits', key: 'finishOn' } as const, 'pr')
const record = atom({ plugin: 'speedrun-splits', key: 'record' } as const, null)

export const PHASES = ['recon', 'first blood', 'test run', 'green', 'commit', 'PR'] as const
const RECON = 0
const FIRST_BLOOD = 1
const TEST_RUN = 2
const GREEN = 3
const COMMIT = 4
const PR = 5

const PERSON = ['composer', 'bridge', 'sdk', 'channel', 'slack-ping']
const HISTORY = 20
// Finished runs kept per repo and finish line, beyond the ones holding the PB or a gold.
const KEEP = 50
const FINISH_KEY = 'finish-on'

// ---------------------------------------------------------------------------
// Reading shell commands. Conservative: when it is unclear whether a test ran
// and passed, it did not.

// Options a package manager takes before its script name (`--filter app`, `-w app`).
const PM_OPTS = String.raw`(\s+--?[\w-]+(=\S+)?(\s+(?!(run|test|tests|exec)\b)[^\s-]\S*)?)*`

// A command that runs a test suite.
const TEST_RUNNER = new RegExp(
  '^(' +
    [
      String.raw`(npm|pnpm|yarn|bun)${PM_OPTS}\s+(run\s+)?tests?(:\S+)?\b`,
      String.raw`(npx|pnpx|bunx)(\s+(-y|--yes))?\s+(jest|vitest|mocha|playwright\s+test)\b`,
      String.raw`(pnpm|yarn)\s+(exec|dlx)\s+(jest|vitest|mocha)\b`,
      String.raw`yarn\s+workspace\s+\S+\s+(run\s+)?tests?\b`,
      String.raw`(jest|vitest|pytest|mocha|rspec|phpunit)\b`,
      String.raw`node\s+--test\b`,
      String.raw`(uv|poetry|pipenv)\s+run\s+(pytest|python3?\s+-m\s+pytest)\b`,
      String.raw`python3?\s+-m\s+(pytest|unittest)\b`,
      String.raw`go\s+test\b`,
      String.raw`cargo\s+(test|nextest)\b`,
      String.raw`swift\s+test\b`,
      String.raw`dotnet\s+test\b`,
      String.raw`make\s+tests?(?![\w-])`,
      String.raw`xcodebuild\b.*\btest\b`,
      String.raw`(\./)?gradlew\s+(\S+\s+)*\S*[Tt]est\b`,
      String.raw`mix\s+test\b`,
    ].join('|') +
    ')',
)

// A typecheck: it ends the test-run segment but never proves green.
const TYPECHECK = new RegExp(
  '^(' +
    [
      String.raw`(npm|pnpm|yarn|bun)${PM_OPTS}\s+(run\s+)?(typecheck|type-check|tsc)\b`,
      String.raw`(npx|pnpx|bunx)(\s+(-y|--yes))?\s+tsc\b`,
      String.raw`tsc\b`,
      String.raw`make\s+check\b`,
    ].join('|') +
    ')',
)

// Arguments that list, compile or explain instead of running tests, checked
// with quotes removed but their contents kept (`pytest "--collect-only"`).
const NOT_A_RUN =
  /(^|\s)(--help|-h|--version|-V|--collect-only|--co|--setup-only|--fixtures|--showConfig|--no-run|--listTests|--list-tests|--list|-list|--dry-run)(\s|=|$)|\b(vitest|jest)\s+list\b|\bgo\s+test\b.*\s-c(\s|$)/

// The command as words: a quoted single word keeps its text (`pytest "--collect-only"`,
// `cd "packages/app"`), quoted text with spaces is data and goes, comments go.
export function words(command: string): string {
  const unwrap = (_: string, body: string) => (/^\S+$/.test(body) ? body : "''")
  return command
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, ' ')
    .replace(/'([^']*)'/g, unwrap)
    .replace(/"((?:[^"\\]|\\.)*)"/g, unwrap)
    .replace(/(^|\s)#[^\n]*/g, '$1')
}

// Shell text ready to split into statements and parts.
function prep(command: string): string {
  return words(command)
    .replace(/\|&/g, '|') // `|&` pipes stderr too: still a pipe
    .replace(/\d*>&\d+|&>>?|>&/g, ' ') // redirections, not background jobs
    .replace(/[()]/g, ' ') // subshell grouping
}

// Leading `VAR=x`, `timeout 60`, `time`, `env`, `command` don't change what runs.
function normalize(segment: string): string {
  let s = segment.trim()
  for (;;) {
    const next = s.replace(/^(\w+=\S*|timeout\s+\S+|time|env|command|nice|nohup)\s+/, '')
    if (next === s) return s
    s = next
  }
}

const isRunner = (s: string) => TEST_RUNNER.test(s) && !NOT_A_RUN.test(s)
const isCheck = (s: string) => TYPECHECK.test(s) && !NOT_A_RUN.test(s)
const hasTest = (part: string) => part.split('|').map(normalize).some(s => isRunner(s) || isCheck(s))

export type Shell = {
  // Some part of the command is a test or typecheck.
  runsTest: boolean
  // A test or typecheck must have started even if the command failed.
  startsAnyway: boolean
  // Success of the whole command proves a test suite ran and passed.
  provesPass: boolean
}

const NONE: Shell = { runsTest: false, startsAnyway: false, provesPass: false }

export function analyze(command: string): Shell {
  const statements = prep(command).split(/;|\n/).filter(st => st.trim() !== '')
  const runsTest = statements.some(st => st.split(/&&|\|\||&/).some(hasTest))
  if (!runsTest) return NONE
  // Only the first statement surely runs: `set -e`, `exit` or a failure can stop the rest.
  const first = statements[0] ?? ''
  const startsAnyway = hasTest(first.split(/&&|\|\||(?<!&)&(?!&)/)[0] ?? '')
  // Only the last statement sets the exit status; a `&` in it sends its work to the background.
  const last = statements[statements.length - 1] ?? ''
  const isBackground = /(^|[^&])&([^&]|$)/.test(last)
  const provesPass =
    !isBackground &&
    !last.includes('||') &&
    last.split('&&').some(part => {
      const pipeline = part.split('|')
      // A pipeline's status is its last command's.
      return isRunner(normalize(pipeline[pipeline.length - 1] ?? ''))
    })
  return { runsTest, startsAnyway, provesPass }
}

// Did a test start, given whether the whole call succeeded? If it succeeded,
// every part of the last statement ran.
export function testStarted(shell: Shell, command: string, ok: boolean): boolean {
  if (!shell.runsTest) return false
  if (shell.startsAnyway) return true
  if (!ok) return false
  const statements = prep(command).split(/;|\n/).filter(st => st.trim() !== '')
  const last = statements[statements.length - 1] ?? ''
  return !last.includes('||') && last.split(/&&|(?<!&)&(?!&)/).some(hasTest)
}

// Where a command's git work happens, as far as the text says: `here`, a
// directory to resolve, or `unknown` (another git dir, or a target we can't read).
export type Target = { kind: 'here' } | { kind: 'dir'; dir: string } | { kind: 'unknown' }

// The git commit or `gh pr create` in a command: where it starts, and the git global options.
const COMMIT_AT = /\bgit((?:\s+(?:-c\s+\S+|-C\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+commit(?![\w-])/
const PR_AT = /\bgh\s+pr\s+create\b/

// Where the milestone in a command runs. Only what comes before it can move it;
// anything ambiguous is `unknown`, so nothing is credited.
export function gitTarget(command: string): Target {
  const text = words(command)
  if (/(^|\s)(GIT_DIR|GIT_WORK_TREE)=/.test(text)) return { kind: 'unknown' }
  const commit = COMMIT_AT.exec(text)
  const pr = PR_AT.exec(text)
  const at = commit?.index ?? pr?.index ?? -1
  const before = at === -1 ? text : text.slice(0, at)
  if (/(^|[;&|\s])(pushd|popd)\b/.test(before)) return { kind: 'unknown' }
  const cds = [...before.matchAll(/(^|[;&|(]\s*)cd\s+(\S+)/g)].map(m => m[2] ?? '')
  // More than one hop, or one inside a subshell that may have ended: can't tell.
  if (cds.length > 1 || (cds.length === 1 && before.includes('('))) return { kind: 'unknown' }
  let dir: string | null = null
  if (commit !== null) {
    const opts = commit[1] ?? ''
    if (/--git-dir|--work-tree/.test(opts)) return { kind: 'unknown' }
    const cs = [...opts.matchAll(/-C\s+(\S+)/g)].map(m => m[1] ?? '')
    if (cs.length > 1) return { kind: 'unknown' }
    dir = cs[0] ?? null
  }
  const to = cds[0]
  if (to !== undefined) {
    if (/[$`~*?]/.test(to) || to === '' || to === '-' || to === "''") return { kind: 'unknown' }
    if (dir === null) dir = to
    else if (!dir.startsWith('/')) dir = `${to}/${dir}`
  }
  if (dir === null || dir === '.') return { kind: 'here' }
  if (/[$`~*?]/.test(dir) || dir === "''") return { kind: 'unknown' }
  return { kind: 'dir', dir }
}

// `gh ... -R owner/repo` / `--repo owner/repo`: the repo, `unknown` if it can't be read, null if not given.
export function ghRepoFlag(command: string): string | null {
  const m = /\bgh\s+(?:\S+\s+)*?(?:-R|--repo)(?:\s+|=)(\S+)/.exec(words(command))
  if (m === null) return null
  return (m[1] === undefined ? null : ownerRepo(m[1])) ?? 'unknown'
}

// `owner/repo` from a remote URL, a PR URL, or `host/owner/repo`: host aliases,
// ports and credentials don't change which repo it is.
export function ownerRepo(url: string): string | null {
  const s = url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\.git\/?$/, '')
    .replace(/\/pull\/.*$/, '')
    .replace(/\/+$/, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length < 2) return null
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase()
}

// ---------------------------------------------------------------------------
// Times and records.

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = hours > 0 ? String(m).padStart(2, '0') : String(m)
  const lead = hours > 0 ? String(hours) + ':' : ''
  return lead + mm + ':' + String(s).padStart(2, '0')
}

export function delta(ms: number): string {
  return `${ms < 0 ? '−' : '+'}${clock(Math.abs(ms))}`
}

// The phase reached just before phase i (in time), or null if none was.
// Two phases stamped at once: the earlier phase in the list came first.
function previousPhase(splits: (number | null)[], i: number): number | null {
  const at = splits[i]
  if (at === null || at === undefined) return null
  let best: number | null = null
  splits.forEach((v, j) => {
    if (j === i || v === null || !(v < at || (v === at && j < i))) return
    const b = best === null ? null : splits[best]
    if (best === null || (b !== null && b !== undefined && (v > b || (v === b && j > best)))) best = j
  })
  return best
}

// The time spent on phase i: since the phase before it, or since the start.
export function segment(splits: (number | null)[], i: number): number | null {
  const at = splits[i]
  if (at === null || at === undefined) return null
  const p = previousPhase(splits, i)
  return at - (p === null ? 0 : (splits[p] ?? 0))
}

// A segment can be gold only when it was run in order: recon as the first
// split, timed from the start; any other phase right after an earlier phase.
export function goldable(splits: (number | null)[], i: number): number | null {
  const seg = segment(splits, i)
  if (seg === null || seg <= 0) return null
  const p = previousPhase(splits, i)
  if (i === RECON) return p === null ? seg : null
  return p !== null && p < i ? seg : null
}

// A run that never changed code, or took no time, is history but never a record.
export const qualifies = (splits: (number | null)[], total: number) => splits[FIRST_BLOOD] !== null && total > 0

export const emptyBest = (): Best => ({ pb: null, gold: PHASES.map(() => null), goldIds: PHASES.map(() => null), history: [] })

export function fold(best: Best, splits: (number | null)[], total: number, date: string, id?: string): Best {
  const counts = qualifies(splits, total)
  const isPb = counts && (best.pb === null || total < best.pb.total)
  const goldIds = best.goldIds ?? PHASES.map(() => null)
  const gold: (number | null)[] = []
  const ids: (string | null)[] = []
  PHASES.forEach((_, i) => {
    const was = best.gold[i] ?? null
    const seg = counts ? goldable(splits, i) : null
    const wins = seg !== null && (was === null || seg < was)
    gold.push(wins ? seg : was)
    ids.push(wins ? (id ?? null) : (goldIds[i] ?? null))
  })
  return {
    pb: isPb ? { total, splits: [...splits], id } : best.pb,
    gold,
    goldIds: ids,
    history: [{ id, date, total, splits: [...splits] }, ...best.history].slice(0, HISTORY),
  }
}

export const sumOfBest = (gold: (number | null)[]) =>
  gold.every(g => g !== null) ? gold.reduce<number>((s, g) => s + (g ?? 0), 0) : null

const isTime = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= 0)
const isTimes = (v: unknown) => Array.isArray(v) && v.length === PHASES.length && v.every(isTime)

// A finished run as stored, if it is one this mod wrote.
export function asFinished(v: unknown): Finished | null {
  if (typeof v !== 'object' || v === null) return null
  const f = v as Finished
  const ok =
    typeof f.id === 'string' &&
    typeof f.date === 'string' &&
    typeof f.startedAt === 'number' &&
    Number.isFinite(f.startedAt) &&
    typeof f.total === 'number' &&
    Number.isFinite(f.total) &&
    f.total >= 0 &&
    isTimes(f.splits)
  return ok ? f : null
}

// Each run is stored under its own key, so sessions finishing at once never
// overwrite each other; the board is folded from them.
const prefix = (repo: string, mode: FinishOn) => `run:${mode}:${encodeURIComponent(repo)}:`
const runKey = (repo: string, mode: FinishOn, id: string) => `${prefix(repo, mode)}${id}`

// ---------------------------------------------------------------------------
// The run.

// Timers live with the module: a reload drops them; whatever runs next restarts the tick.
let tick: Timer | null = null

function startTicking($: EngineInterface) {
  tick?.cancel()
  tick = $.clock.every(1000, () => {
    void $.clock.now().then(t => update($, now, () => t))
  })
}

function stopTicking() {
  tick?.cancel()
  tick = null
}

async function ensureTicking($: EngineInterface, r: Run | null) {
  if (tick === null && r !== null && r.endedAt === null) startTicking($)
}

// A stable identity (owner/repo of the remote, else the main worktree's root) and a name to show.
async function repoOf($: EngineInterface): Promise<{ id: string; name: string }> {
  try {
    const repo = await $.session.repo()
    if (repo !== null) {
      const name = repo.name ?? repo.root.split('/').filter(Boolean).pop() ?? 'repo'
      const remote = repo.remote === null ? null : ownerRepo(repo.remote)
      return { id: remote ?? repo.root, name }
    }
  } catch {
    // Fall through: not a repo, or the host could not say.
  }
  return { id: 'no-repo', name: 'no repo' }
}

async function finishedRuns($: EngineInterface, repo: string, mode: FinishOn): Promise<{ key: string; run: Finished }[]> {
  const p = prefix(repo, mode)
  const keys = (await $.store.keys()).filter(k => k.startsWith(p))
  const runs: { key: string; run: Finished }[] = []
  for (const key of keys) {
    const f = asFinished(await $.store.get(key))
    if (f !== null) runs.push({ key, run: f })
  }
  return runs.sort((a, b) => a.run.startedAt - b.run.startedAt)
}

export function board(runs: Finished[]): Best {
  return runs.reduce((b, f) => fold(b, f.splits, f.total, f.date, f.id), emptyBest())
}

async function loadBest($: EngineInterface, repo: string, mode: FinishOn): Promise<Best> {
  return board((await finishedRuns($, repo, mode)).map(x => x.run))
}

async function start($: EngineInterface) {
  const repo = await repoOf($)
  const mode = await read($, finishOn)
  const startedAt = await $.clock.now()
  const best = await loadBest($, repo.id, mode)
  const id = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`
  stopWatchers()
  await update($, record, () => best)
  await update($, run, (): Run => ({
    id,
    repo: repo.id,
    repoName: repo.name,
    finishOn: mode,
    startedAt,
    splits: PHASES.map(() => null),
    endedAt: null,
  }))
  await update($, now, () => startedAt)
  startTicking($)
}

// Stamps `phase` at time `t` on run `id`, once, if that run is still open.
// Ends the run when the phase is its finish line.
async function split($: EngineInterface, id: string, phase: number, t: number) {
  let wrote = false
  const after = await update($, run, r => {
    wrote = false
    if (r === null || r.id !== id || r.endedAt !== null || r.splits[phase] !== null) return r
    wrote = true
    return { ...r, splits: r.splits.map((v, i) => (i === phase ? Math.max(0, t - r.startedAt) : v)) }
  })
  if (!wrote || after === null) return
  await update($, now, cur => Math.max(cur, t))
  if (phase === (after.finishOn === 'commit' ? COMMIT : PR)) await finish($, id, t)
}

async function finish($: EngineInterface, id: string, t: number) {
  let won = false
  const ended = await update($, run, r => {
    won = false
    if (r === null || r.id !== id || r.endedAt !== null) return r
    won = true
    return { ...r, endedAt: t }
  })
  // Only the call that closed this run records it.
  if (!won || ended === null) return
  stopTicking()
  const total = t - ended.startedAt
  const before = (await finishedRuns($, ended.repo, ended.finishOn)).filter(x => x.run.id !== id)
  const wasPb = board(before.map(x => x.run)).pb?.total ?? null
  const mine: Finished = {
    id,
    date: new Date(ended.startedAt).toISOString(),
    startedAt: ended.startedAt,
    total,
    splits: ended.splits,
  }
  const key = runKey(ended.repo, ended.finishOn, id)
  await $.store.set(key, mine)
  if (asFinished(await $.store.get(key)) === null) {
    $.ui.toast(`Speedrun Splits: could not save this run (${clock(total)})`)
    return
  }
  await prune($, [...before, { key, run: mine }])

  if (!qualifies(ended.splits, total)) {
    $.ui.toast(`🏁 Run done: ${clock(total)} (no code change, so not a record)`)
  } else if (wasPb === null || total < wasPb) {
    $.ui.toast(`🏁 New PB on ${ended.repoName}: ${clock(total)}`)
  } else {
    $.ui.toast(`🏁 Run done: ${clock(total)} (PB ${clock(wasPb)})`)
  }
}

// Keeps the newest runs and every run that holds the PB or a gold.
async function prune($: EngineInterface, runs: { key: string; run: Finished }[]) {
  if (runs.length <= KEEP) return
  const b = board(runs.map(x => x.run))
  const holders = new Set([b.pb?.id, ...(b.goldIds ?? [])].filter((x): x is string => typeof x === 'string'))
  const newest = new Set(runs.slice(-KEEP).map(x => x.run.id))
  for (const x of runs) if (!newest.has(x.run.id) && !holders.has(x.run.id)) await $.store.delete(x.key)
}

async function reset($: EngineInterface) {
  stopTicking()
  stopWatchers()
  await update($, run, () => null)
}

async function table($: EngineInterface): Promise<string> {
  const r = await read($, run)
  const repo = r !== null ? { id: r.repo, name: r.repoName } : await repoOf($)
  const mode = r?.finishOn ?? (await read($, finishOn))
  const best = await loadBest($, repo.id, mode)
  const lines = [`Speedrun Splits: ${repo.name} (bug → ${mode === 'pr' ? 'PR' : 'commit'})`, '']
  if (best.pb === null) {
    lines.push('No record yet. A run starts on your next prompt, or /splits start.')
  } else {
    lines.push(`Personal best: ${clock(best.pb.total)}`, '', 'Phase         PB split    Gold segment')
    PHASES.forEach((name, i) => {
      const at = best.pb?.splits[i] ?? null
      const gold = best.gold[i] ?? null
      lines.push(`${name.padEnd(13)} ${(at === null ? '—' : clock(at)).padEnd(11)} ${gold === null ? '—' : clock(gold)}`)
    })
    const sob = sumOfBest(best.gold)
    if (sob !== null) lines.push('', `Sum of best: ${clock(sob)}`)
  }
  if (best.history.length > 0) {
    lines.push('', 'Recent runs:')
    for (const past of best.history.slice(0, 5)) lines.push(`  ${past.date.slice(0, 16).replace('T', ' ')}  ${clock(past.total)}`)
  }
  return lines.join('\n')
}

async function clear($: EngineInterface): Promise<string> {
  const r = await read($, run)
  const repo = r !== null ? { id: r.repo, name: r.repoName } : await repoOf($)
  const mode = r?.finishOn ?? (await read($, finishOn))
  for (const x of await finishedRuns($, repo.id, mode)) await $.store.delete(x.key)
  // Unreadable entries under this repo's prefix go too.
  const p = prefix(repo.id, mode)
  for (const k of await $.store.keys()) if (k.startsWith(p)) await $.store.delete(k)
  if (r !== null) await update($, record, () => emptyBest())
  return `Speedrun Splits: cleared PBs, golds and history for ${repo.name} (bug → ${mode === 'pr' ? 'PR' : 'commit'}).`
}

// The git common dir of a directory, to tell one repo from another (worktrees share it).
async function commonDir($: EngineInterface, dir: string): Promise<string | null> {
  try {
    const out = await $.process.run(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      timeoutMs: 3000,
    })
    return out.exitCode === 0 ? out.stdout.trim() : null
  } catch {
    return null
  }
}

// Is the git work of this command in the session's repo?
async function isHere($: EngineInterface, command: string): Promise<boolean> {
  return (await dirOf($, command)) !== null
}

// The directory a command's milestone runs in, if it is in the session's repo.
async function dirOf($: EngineInterface, command: string): Promise<string | null> {
  const target = gitTarget(command)
  if (target.kind === 'here') return '.'
  if (target.kind === 'unknown') return null
  const [there, here] = await Promise.all([commonDir($, target.dir), commonDir($, '.')])
  return there !== null && there === here ? target.dir : null
}

type BashResult = {
  backgroundTaskId?: string
  interrupted?: boolean
  gitOperation?: { commit?: { kind: string }; pr?: { action: string; url?: string } }
  bashEditDiff?: { files?: unknown[]; changedFiles?: string[]; unavailable?: true; skipped?: true }
}

// A shell command that the host saw change files.
function changedFiles(result: BashResult): boolean {
  const diff = result.bashEditDiff
  if (diff === undefined || diff.unavailable === true || diff.skipped === true) return false
  return (diff.files?.length ?? 0) > 0 || (diff.changedFiles?.length ?? 0) > 0
}

// Shell commands that move files without being a fix: not first blood.
const NOT_A_FIX =
  /(^|[;&|]\s*)((npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade)\b|git\s+(checkout|switch|pull|merge|rebase|stash|reset|restore|clone)\b|pod\s+install\b)/

// What HEAD is in a directory now, to tell a new commit from an old one.
async function headOf($: EngineInterface, dir: string): Promise<string | null> {
  try {
    const out = await $.process.run(['git', '-C', dir, 'rev-parse', 'HEAD'], { timeoutMs: 3000 })
    return out.exitCode === 0 ? out.stdout.trim() : null
  } catch {
    return null
  }
}

// Background commit and PR commands finish later, out of sight of this hook:
// one watcher each, polling for up to ten minutes.
const watchers = new Map<string, Timer>()

function stopWatchers() {
  for (const w of watchers.values()) w.cancel()
  watchers.clear()
}

type Watch = { id: string; dir: string; since: number; head: string | null; wantsCommit: boolean; wantsPr: boolean; repo: string | null }

function watchBackground($: EngineInterface, w: Watch) {
  const key = `${w.id}:${w.since}:${w.wantsCommit ? 'c' : ''}${w.wantsPr ? 'p' : ''}`
  let polls = 0
  const stop = () => {
    watchers.get(key)?.cancel()
    watchers.delete(key)
  }
  watchers.set(
    key,
    $.clock.every(10_000, () => {
      void (async () => {
        polls += 1
        const r = await read($, run)
        if (r === null || r.id !== w.id || r.endedAt !== null || polls > 60) return stop()
        const t = await $.clock.now()
        if (w.wantsCommit && w.head !== null) {
          const head = await headOf($, w.dir)
          if (head !== null && head !== w.head) {
            const out = await $.process.run(['git', '-C', w.dir, 'log', '-1', '--format=%ct'], { timeoutMs: 3000 })
            const ct = Number(out.stdout.trim()) * 1000
            // The commit landed between the command's start and now; its own date is editable.
            const at = Number.isFinite(ct) ? Math.min(t, Math.max(w.since, ct)) : t
            await split($, w.id, COMMIT, at)
            if (!w.wantsPr) return stop()
          }
        }
        if (w.wantsPr) {
          const out = await $.process.run(['gh', 'pr', 'view', '--json', 'url,createdAt'], { timeoutMs: 8000, cwd: w.dir })
          if (out.exitCode === 0) {
            const pr = JSON.parse(out.stdout) as { url?: string; createdAt?: string }
            const at = Date.parse(pr.createdAt ?? '')
            const target = pr.url === undefined ? null : ownerRepo(pr.url)
            const sameRepo = w.repo === null || w.repo.startsWith('/') || target === w.repo
            if (Number.isFinite(at) && at >= w.since && sameRepo) {
              await split($, w.id, PR, Math.min(t, at))
              return stop()
            }
          }
        }
      })().catch(() => undefined)
    }),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'splits',
        description: 'Speedrun Splits: PB table, or start | reset | clear | hide | show | finish-on pr|commit',
        argumentHint: '[start|reset|clear|hide|show|finish-on pr|commit]',
        immediate: true,
      })
    } catch {
      // The command is optional; the session is not.
    }
    try {
      const saved = await $.store.get(FINISH_KEY)
      if (saved === 'pr' || saved === 'commit') await update($, finishOn, () => saved)
      // A reload drops timers: resume ticking a run that was in flight.
      await ensureTicking($, await read($, run))
    } catch {
      // Defaults stand.
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    stopTicking()
    stopWatchers()
    return next(e)
  })

  on('command.run', { command: 'splits' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    switch (verb) {
      case 'start':
        await start($)
        return { text: 'Speedrun Splits: run started. Go.' }
      case 'reset':
        await reset($)
        return { text: 'Speedrun Splits: run reset.' }
      case 'clear':
        return { text: await clear($) }
      case 'hide':
      case 'show':
        await update($, hidden, () => verb === 'hide')
        return { text: `Speedrun Splits: timer ${verb === 'hide' ? 'hidden' : 'shown'}.` }
      case 'finish-on':
        if (arg !== 'pr' && arg !== 'commit') return { text: 'Usage: /splits finish-on pr|commit' }
        await update($, finishOn, () => arg)
        await $.store.set(FINISH_KEY, arg)
        return {
          text: `Speedrun Splits: new runs finish on the ${arg === 'pr' ? 'PR' : 'commit'} (the current run keeps its finish line).`,
        }
      default:
        return { text: await table($) }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    if (PERSON.includes(e.origin.kind)) {
      try {
        const r = await read($, run)
        if (r === null || r.endedAt !== null) await start($)
        else await ensureTicking($, r)
      } catch {
        // Never hold a prompt back for the timer.
      }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    let id: string | null = null
    let repo: string | null = null
    let command = ''
    let shell: Shell = NONE
    // Tests only count once the run has changed code, decided as the call starts:
    // a baseline run that finishes after an edit is still a baseline run.
    let afterBlood = false
    let startedAt = 0
    let gitDir: string | null = null
    let head: string | null = null
    try {
      const r = await read($, run)
      await ensureTicking($, r)
      id = r !== null && r.endedAt === null ? r.id : null
      repo = r?.repo ?? null
      afterBlood = r?.splits[FIRST_BLOOD] !== null && r?.splits[FIRST_BLOOD] !== undefined
      if (id !== null && e.tool === 'Bash') {
        command = String(e.command ?? '')
        shell = analyze(command)
        startedAt = await $.clock.now()
        // A commit that may go to the background: remember HEAD, to know a new commit when it lands.
        if (COMMIT_AT.test(words(command))) {
          gitDir = await dirOf($, command)
          head = gitDir === null ? null : await headOf($, gitDir)
        }
      }
    } catch {
      id = null
    }

    const ran = await next(e)
    if (id === null || ran.deny !== undefined) return ran

    try {
      const t = await $.clock.now()
      const ok = ran.isError !== true
      const result = (ran.result ?? {}) as BashResult & { staged?: boolean }
      if (e.tool === 'Read') {
        if (isMain && ok) await split($, id, RECON, t)
      } else if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
        // Any agent's change counts: delegated fixes are still fixes.
        if (ok && result.staged !== true) await split($, id, FIRST_BLOOD, t)
      } else if (e.tool === 'Bash') {
        if (result.backgroundTaskId !== undefined) {
          const text = words(command)
          const wantsCommit = COMMIT_AT.test(text) && head !== null
          const wantsPr = PR_AT.test(text) && ghRepoFlag(command) === null
          const dir = gitDir ?? (await dirOf($, command))
          if ((wantsCommit || wantsPr) && dir !== null) {
            watchBackground($, { id, dir, since: startedAt, head, wantsCommit, wantsPr, repo })
          }
          return ran
        }
        // An interrupted command proves nothing.
        if (result.interrupted === true) return ran
        if (ok && changedFiles(result) && !NOT_A_FIX.test(words(command))) await split($, id, FIRST_BLOOD, t)
        if (afterBlood && testStarted(shell, command, ok)) {
          // The test-run segment ends when the tests start; their run time counts toward green.
          await split($, id, TEST_RUN, startedAt)
          if (ok && shell.provesPass) await split($, id, GREEN, t)
        }
        // A commit made before a later step failed is still a commit.
        const op = result.gitOperation
        if (op !== undefined && (await isHere($, command))) {
          const kind = op.commit?.kind
          if (kind === 'committed' || kind === 'amended') await split($, id, COMMIT, t)
          if (op.pr?.action === 'created') {
            const target = op.pr.url === undefined ? ghRepoFlag(command) : ownerRepo(op.pr.url)
            // Credit a PR only to the repo it was opened on; with no remote to compare, the
            // PR must not name a repo at all. An unreadable `-R` is never this repo.
            const sameRepo =
              target === null || (target !== 'unknown' && repo !== null && !repo.startsWith('/') && repo === target)
            if (sameRepo) await split($, id, PR, t)
          }
        }
      }
    } catch {
      // Timing is never worth failing a tool call over.
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, run)
    if (r === null || e.props.hasSurvey || (await read($, hidden))) return next(e)
    const t = await read($, now)
    const best = (await read($, record)) ?? emptyBest()
    const { Box, Text } = $.ui.resolve(e)
    const elapsed = (r.endedAt ?? Math.max(t, r.startedAt)) - r.startedAt
    const highest = r.splits.reduce<number>((last, v, i) => (v !== null ? i : last), -1)
    const pending = r.splits.findIndex((v, i) => i > highest && v === null)
    const columns = e.props.bodyColumns ?? 80
    const room = Math.max(1, Math.floor((columns - 24) / 22))
    const shown = PHASES.map((name, i) => ({ name, i }))
      .filter(({ i }) => r.splits[i] !== null)
      .sort((a, b) => (r.splits[a.i] ?? 0) - (r.splits[b.i] ?? 0))
      .slice(-room)

    // One AbovePrompt for every plugin: draw this band on top of what the plugins below drew.
    const below = await next(e)
    const mine = (
      <Box>
        <Text bold color={r.endedAt !== null ? 'green' : undefined}>
          {r.endedAt !== null ? '🏁 ' : '⏱ '}
          {clock(elapsed)}{' '}
        </Text>
        {shown.map(({ name, i }) => {
          const at = r.splits[i] ?? 0
          const pbAt = best.pb?.splits[i] ?? null
          const seg = goldable(r.splits, i)
          const gold = best.gold[i] ?? null
          // Compared with the board from before this run, so a fresh PB still shows its margins.
          const isGold = seg !== null && (gold === null ? best.pb !== null : seg < gold)
          const d = pbAt === null ? null : at - pbAt
          return (
            <Text key={name}>
              <Text dimColor>│ {name} </Text>
              {isGold ? (
                <Text color="yellow">★{d === null ? clock(at) : delta(d)} </Text>
              ) : d === null ? (
                <Text>{clock(at)} </Text>
              ) : (
                <Text color={d <= 0 ? 'green' : 'red'}>{delta(d)} </Text>
              )}
            </Text>
          )
        })}
        {r.endedAt === null && pending !== -1 && <Text dimColor>│ next: {PHASES[pending]}</Text>}
      </Box>
    )
    return (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })
}
