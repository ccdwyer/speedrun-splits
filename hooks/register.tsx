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

// Characters that make quoted text shell syntax rather than one plain word.
const OPERATORS = /[;&|<>()`$\n]/

// The command as words: a quoted single plain word keeps its text (`pytest "--collect-only"`,
// `cd "packages/app"`), other quoted text is data and goes, comments go.
export function words(command: string): string {
  const unwrap = (_: string, body: string) => (/^\S+$/.test(body) && !OPERATORS.test(body) ? body : "''")
  return command
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, ' ')
    .replace(/'([^']*)'/g, unwrap)
    .replace(/"((?:[^"\\]|\\.)*)"/g, unwrap)
    .replace(/(^|\s)#[^\n]*/g, '$1')
}

// A lone `&` ends an and-or list and sends the whole list to the background
// (`npm test && echo done &` backgrounds the test too).
const LONE_AMP = /(?<!&)&(?!&)/

// Pipes and redirections that look like `&` but are not background jobs.
const unredirect = (text: string) => text.replace(/\|&/g, '|').replace(/\d*>&\d+|&>>?|>&/g, ' ')

// A subshell that backgrounds a job inside it returns at once: for the outer list it is `true`.
function maskBackgroundSubshells(text: string): string {
  let s = text
  for (let prev = ''; prev !== s; ) {
    prev = s
    s = s.replace(/\(([^()]*)\)/g, (_, body: string) => (LONE_AMP.test(body) ? ' true ' : `\u0001${body}\u0002`))
  }
  return s.replace(/\u0001/g, '(').replace(/\u0002/g, ')')
}

// Shell text ready to split into statements and parts, subshell grouping dropped.
function prep(command: string): string {
  return maskBackgroundSubshells(unredirect(words(command))).replace(/[()]/g, ' ')
}

// Words that start a command without changing which program it is: assignments, wrappers,
// and the shell keywords that open a body (`then npm test`).
const PREFIX =
  /^(\w+=\S*|timeout(?:\s+-\S+)*\s+\S+|time|env(?:\s+-\S+)*|command|nice(?:\s+-n\s+\S+)?|nohup|sudo(?:\s+(?:-[ugCDhpr]\s+\S+|-\w+))*|then|do|else|elif|if|while|until|!|\{)\s+/

function normalize(segment: string): string {
  let s = segment.trim()
  for (;;) {
    const next = s.replace(PREFIX, '')
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
  // An `exit` or `return` before the last statement can end the call, successfully, before the tests.
  exitsEarly: boolean
}

const NONE: Shell = { runsTest: false, startsAnyway: false, provesPass: false, exitsEarly: false }

// The parts of a statement that run in the foreground: only the list after the last
// lone `&`, split into its commands. Lists before a `&` run in the background, unseen.
export function foreground(statement: string): string[] {
  const lists = statement.split(LONE_AMP)
  const last = lists[lists.length - 1] ?? ''
  return last.trim() === '' ? [] : last.split(/&&|\|\|/)
}

export function analyze(command: string): Shell {
  const statements = prep(command).split(/;|\n/).filter(st => st.trim() !== '')
  const runsTest = statements.some(st => st.split(/&&|\|\||&/).some(hasTest))
  if (!runsTest) return NONE
  // Only the first statement surely runs: `set -e`, `exit` or a failure can stop the rest.
  const first = statements[0] ?? ''
  // The first command of the first statement runs whatever happens next, unless its list is backgrounded.
  const startsAnyway = !LONE_AMP.test(first) && hasTest(first.split(/&&|\|\|/)[0] ?? '')
  const exitsEarly = statements.slice(0, -1).some(st => /(^|[\s;&|])(exit|return)\b/.test(st))
  // Only the last statement sets the exit status, and only its foreground list.
  const last = statements[statements.length - 1] ?? ''
  const fg = last.split(LONE_AMP).pop() ?? ''
  const provesPass =
    !exitsEarly &&
    fg.trim() !== '' &&
    !fg.includes('||') &&
    fg.split('&&').some(part => {
      const pipeline = part.split('|')
      // A pipeline's status is its last command's.
      return isRunner(normalize(pipeline[pipeline.length - 1] ?? ''))
    })
  return { runsTest, startsAnyway, provesPass, exitsEarly }
}

// Did a test start, given whether the whole call succeeded? If it succeeded,
// every part of the last statement ran.
export function testStarted(shell: Shell, command: string, ok: boolean): boolean {
  if (!shell.runsTest) return false
  if (shell.startsAnyway) return true
  if (!ok || shell.exitsEarly) return false
  const statements = prep(command).split(/;|\n/).filter(st => st.trim() !== '')
  const last = statements[statements.length - 1] ?? ''
  return !last.includes('||') && foreground(last).some(hasTest)
}

// Where a command's git work or tests happen, as far as the text says: `here`, a
// directory to resolve, or `unknown` (another git dir, or a target we can't read).
export type Target = { kind: 'here' } | { kind: 'dir'; dir: string } | { kind: 'unknown' }

const HERE: Target = { kind: 'here' }
const UNKNOWN: Target = { kind: 'unknown' }
const unreadable = (dir: string) => /[$`~*?]/.test(dir) || dir === '' || dir === '-' || dir === "''"

// The command split into its simple commands in order, with the subshell parentheses
// and separators kept as their own tokens.
function tokens(command: string): string[] {
  return unredirect(words(command))
    .split(/(\(|\)|;|\n|&&|\|\||\||&)/)
    .filter(t => t.trim() !== '')
}

const SEPARATOR = /^(;|\n|&&|\|\||\||&)$/

// Walks a command's simple commands, tracking the directory each runs in: one `cd`
// is followed (it ends with its subshell); a second, an unreadable one, or pushd/popd
// makes everything after it `unknown`. `visit` returns a target to stop on.
function walk(command: string, visit: (cmd: string, raw: string, dir: string | null, lost: boolean) => Target | null): Target | null {
  const scopes: (string | null)[] = [null]
  let hops = 0
  let lost = false
  for (const tok of tokens(command)) {
    if (tok === '(') {
      scopes.push(scopes[scopes.length - 1] ?? null)
      continue
    }
    if (tok === ')') {
      if (scopes.length > 1) scopes.pop()
      continue
    }
    if (SEPARATOR.test(tok)) continue
    const cmd = normalize(tok)
    if (/^(pushd|popd)\b/.test(cmd)) {
      lost = true
      continue
    }
    const hop = /^cd(?:\s+(\S+))?\s*$/.exec(cmd)
    if (hop !== null) {
      const to = hop[1] ?? '~'
      hops += 1
      const cur = scopes[scopes.length - 1] ?? null
      if (hops > 1 || unreadable(to)) lost = true
      else scopes[scopes.length - 1] = to.startsWith('/') || cur === null ? to : `${cur}/${to}`
      continue
    }
    const stop = visit(cmd, tok, scopes[scopes.length - 1] ?? null, lost)
    if (stop !== null) return stop
  }
  return null
}

const asTarget = (dir: string | null): Target => (dir === null || dir === '.' ? HERE : unreadable(dir) ? UNKNOWN : { kind: 'dir', dir })

// A runner's own directory option, before its script name and any `--`:
// `npm --prefix app test`, `pnpm -C app test`, `make -C app test`.
const DIR_OPT = /(?:^|\s)(?:--prefix|--cwd|--dir|--root-dir|-C)(?:\s+|=)(\S+)/
function dirOption(cmd: string): string | null {
  let head = cmd.split(/\s--(?:\s|$)/)[0] ?? ''
  if (/^(npm|pnpm|yarn|bun)\b/.test(head)) head = head.split(/\s(?:run|exec|tests?)\b/)[0] ?? ''
  return DIR_OPT.exec(head)?.[1] ?? null
}

// Where a command's tests run. Every test in it must run in the same place; otherwise,
// or when the place can't be read, `unknown`.
export function testTarget(command: string): Target {
  let found: string | null | undefined
  const stop = walk(command, (cmd, _raw, dir, lost) => {
    if (!hasTest(cmd)) return null
    if (lost) return UNKNOWN
    const opt = dirOption(cmd)
    if (opt !== null && unreadable(opt)) return UNKNOWN
    const at = opt === null ? dir : opt.startsWith('/') || dir === null ? opt : `${dir}/${opt}`
    const key = at === null || at === '.' ? null : at
    if (found !== undefined && found !== key) return UNKNOWN
    found = key
    return null
  })
  return stop ?? asTarget(found ?? null)
}

// A git commit, or a `gh pr create`, as the program a simple command runs (global options allowed).
const COMMIT_CMD = /^git((?:\s+(?:-c\s+\S+|-C\s+\S+|--?[\w-]+(?:=\S+)?))*)\s+commit(?![\w-])/
const PR_CMD = /^gh((?:\s+(?:-R|--repo)(?:\s+|=)\S+|\s+--?[\w-]+(?:=\S+)?)*)\s+pr\s+create\b/

// Does the command run a commit / `gh pr create` itself (not as text an `echo` prints)?
export const hasCommit = (command: string) => walk(command, cmd => (COMMIT_CMD.test(cmd) ? HERE : null)) !== null
export const hasPr = (command: string) => walk(command, cmd => (PR_CMD.test(cmd) ? HERE : null)) !== null

// Where the milestone in a command runs. Anything ambiguous is `unknown`, so nothing is credited.
export function gitTarget(command: string, which: 'commit' | 'pr' = 'commit'): Target {
  if (/(^|\s)(GIT_DIR|GIT_WORK_TREE)=/.test(words(command))) return UNKNOWN
  const re = which === 'commit' ? COMMIT_CMD : PR_CMD
  const at = walk(command, (cmd, _raw, dir, lost) => {
    const m = re.exec(cmd)
    if (m === null) return null
    if (lost) return UNKNOWN
    if (which === 'pr') return asTarget(dir)
    const opts = m[1] ?? ''
    if (/--git-dir|--work-tree/.test(opts)) return UNKNOWN
    const cs = [...opts.matchAll(/-C\s+(\S+)/g)].map(c => c[1] ?? '')
    if (cs.length > 1) return UNKNOWN
    const c = cs[0]
    if (c === undefined) return asTarget(dir)
    if (unreadable(c)) return UNKNOWN
    return asTarget(c.startsWith('/') || dir === null ? c : `${dir}/${c}`)
  })
  return at ?? HERE
}

// The `gh pr create` simple command, its options, and what was set for it.
function prCommand(command: string): { args: string; repo: string | undefined } | null {
  let exported: string | undefined
  let found: { args: string; repo: string | undefined } | null = null
  walk(command, (cmd, raw) => {
    const exp = /^export\s+GH_REPO=(\S+)/.exec(cmd)
    if (exp !== null) {
      exported = exp[1]
      return null
    }
    const m = PR_CMD.exec(cmd)
    if (m === null) return null
    const flag = (text: string) => /(?:^|\s)(?:-R|--repo)(?:\s+|=)(\S+)/.exec(text)?.[1]
    const assigned = /(?:^|\s)GH_REPO=(\S+)/.exec(raw.slice(0, Math.max(0, raw.search(/\bgh\b/))))?.[1]
    found = { args: cmd.slice(m[0].length), repo: flag(cmd.slice(m[0].length)) ?? flag(m[1] ?? '') ?? assigned ?? exported }
    return HERE
  })
  return found
}

// The repo `gh pr create` was pointed at (`-R`, `--repo`, or `GH_REPO` for that command):
// owner/repo, `unknown` if it can't be read, null if it names none.
export function ghRepoFlag(command: string): string | null {
  const pr = prCommand(command)
  if (pr === null || pr.repo === undefined) return null
  return ownerRepo(pr.repo) ?? 'unknown'
}

// The branch `gh pr create` names with `--head` / `-H`, if any (`owner:branch` gives the branch).
export function prHead(command: string): string | null {
  const m = /(?:^|\s)(?:--head(?:\s+|=)|-H\s+)(\S+)/.exec(prCommand(command)?.args ?? '')
  return m?.[1] === undefined ? null : m[1].replace(/^[^:]+:/, '')
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

// The directory a command's milestone runs in, if it is in the session's repo.
async function dirOf($: EngineInterface, command: string, which: 'commit' | 'pr' = 'commit'): Promise<string | null> {
  const target = gitTarget(command, which)
  if (target.kind === 'here') return '.'
  if (target.kind === 'unknown') return null
  const there = await commonDir($, target.dir)
  const here = await commonDir($, '.')
  return there !== null && there === here ? target.dir : null
}

type BashResult = {
  backgroundTaskId?: string
  interrupted?: boolean
  gitOperation?: { commit?: { kind: string }; pr?: { action: string; url?: string } }
  bashEditDiff?: { files?: { filePath: string }[]; changedFiles?: string[]; unavailable?: true; skipped?: true }
}

// Files a test run or a tool writes as a side effect: never a fix.
const NOT_CODE = /(^|\/)(coverage|\.nyc_output|__snapshots__|\.pytest_cache|\.mypy_cache|\.ruff_cache|node_modules|\.turbo|\.next|dist|build)\/|\.snap$|\.lcov$|\.pyc$/

// A path with `.` and `..` resolved.
export function resolvePath(path: string): string {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return `/${out.join('/')}`
}

// Changed files the host saw a shell command make that look like code, absolute against `cwd`.
export function changedCode(result: BashResult, cwd: string): string[] {
  const diff = result.bashEditDiff
  if (diff === undefined || diff.unavailable === true || diff.skipped === true) return []
  const paths = [...(diff.changedFiles ?? []), ...(diff.files ?? []).map(f => f.filePath)]
  const code = paths
    .filter(f => typeof f === 'string' && f !== '')
    .map(f => resolvePath(f.startsWith('/') ? f : `${cwd}/${f}`))
    .filter(f => !NOT_CODE.test(f))
  return [...new Set(code)]
}

// Is a path inside a directory?
export function inside(path: string, root: string): boolean {
  const p = resolvePath(path)
  const r = resolvePath(root)
  return p === r || p.startsWith(`${r === '/' ? '' : r}/`)
}

// Shell commands that move files without being a fix: not first blood.
// Wrappers and global options may sit between the program and its subcommand.
const WRAP = String.raw`(?:(?:\w+=\S*|sudo|env|time|nice|nohup|command|timeout\s+\S+|then|do|else|if)\s+)*`
const GIT_OPTS = String.raw`(?:\s+(?:-C|-c)\s+\S+|\s+--?[\w-]+(?:=\S+)?)*`
const NOT_A_FIX = new RegExp(
  String.raw`(?:^|[;&|\n(])\s*` +
    WRAP +
    '(' +
    [
      String.raw`(npm|pnpm|yarn|bun)${PM_OPTS}\s+(i|install|add|ci|update|upgrade)\b`,
      String.raw`git${GIT_OPTS}\s+(checkout|switch|pull|merge|rebase|stash|reset|restore|clone|cherry-pick)\b`,
      String.raw`pod\s+install\b`,
      String.raw`(pip3?|python3?\s+-m\s+pip|uv\s+pip)\s+install\b`,
      String.raw`uv\s+(sync|add)\b`,
      String.raw`poetry\s+(install|add|update|lock)\b`,
      String.raw`bundle(\s+install)?\s*($|[;&|])`,
      String.raw`composer\s+(install|update|require)\b`,
      String.raw`go\s+(get|mod\s+(download|tidy))\b`,
      String.raw`cargo\s+(fetch|update)\b`,
    ].join('|') +
    ')',
)

// What HEAD is in a directory now, to tell a new commit from an old one.
async function headOf($: EngineInterface, dir: string): Promise<string | null> {
  try {
    const out = await $.process.run(['git', '-C', dir, 'rev-parse', 'HEAD'], { timeoutMs: 3000 })
    return out.exitCode === 0 ? out.stdout.trim() : null
  } catch {
    return null
  }
}

// Every remote of a repo as owner/repo: a fork's PRs are opened on its parent.
async function remotesOf($: EngineInterface, dir: string): Promise<Set<string>> {
  const repos = new Set<string>()
  try {
    const out = await $.process.run(['git', '-C', dir, 'remote', '-v'], { timeoutMs: 3000 })
    if (out.exitCode !== 0) return repos
    for (const line of out.stdout.split('\n')) {
      const url = line.split(/\s+/)[1]
      const r = url === undefined ? null : ownerRepo(url)
      if (r !== null) repos.add(r)
    }
  } catch {
    // No remotes known.
  }
  return repos
}

// The repos a PR for this run may be opened on: the run's own, the checkout's
// remotes, and the fork parent GitHub knows of (gh opens a fork's PRs on its parent).
async function ourRepos($: EngineInterface, dir: string, runRepo: string | null): Promise<Set<string>> {
  const repos = await remotesOf($, dir)
  if (runRepo !== null && !runRepo.startsWith('/')) repos.add(runRepo)
  try {
    const out = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner,parent'], { timeoutMs: 8000, cwd: dir })
    if (out.exitCode === 0) {
      const info = JSON.parse(out.stdout) as { nameWithOwner?: string; parent?: { owner?: { login?: string }; name?: string } | null }
      if (typeof info.nameWithOwner === 'string') repos.add(info.nameWithOwner.toLowerCase())
      const login = info.parent?.owner?.login
      const name = info.parent?.name
      if (typeof login === 'string' && typeof name === 'string') repos.add(`${login}/${name}`.toLowerCase())
    }
  } catch {
    // Offline or no gh: the remotes stand.
  }
  return repos
}

// Is a PR opened by this command one for the run's repo? Its URL decides when the host
// gives one; else the repo `gh pr create` was pointed at; else it is this checkout's.
async function prIsOurs($: EngineInterface, command: string, dir: string, url: string | undefined, runRepo: string | null): Promise<boolean> {
  if (url !== undefined) {
    const named = ownerRepo(url)
    return named !== null && (await ourRepos($, dir, runRepo)).has(named)
  }
  const flag = ghRepoFlag(command)
  if (flag === null) return true
  if (flag === 'unknown') return false
  return (await ourRepos($, dir, runRepo)).has(flag)
}

// The branch `gh pr create` opens from: its `--head`, else the checkout's branch.
async function prBranch($: EngineInterface, command: string, dir: string): Promise<string | null> {
  const named = prHead(command)
  if (named !== null) return named
  try {
    const out = await $.process.run(['git', '-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 3000 })
    const b = out.stdout.trim()
    return out.exitCode === 0 && b !== '' && b !== 'HEAD' ? b : null
  } catch {
    return null
  }
}

// Did HEAD in this directory move by a commit (not a checkout, pull, reset or cherry-pick)?
// The reflog says how HEAD got where it is.
async function landedCommit($: EngineInterface, dir: string, was: string | null): Promise<boolean> {
  const head = await headOf($, dir)
  if (head === null || head === was) return false
  try {
    const out = await $.process.run(['git', '-C', dir, 'reflog', '-1', '--format=%H %gs', 'HEAD'], { timeoutMs: 3000 })
    if (out.exitCode !== 0) return false
    const line = out.stdout.trim()
    const sha = line.split(' ')[0]
    const subject = line.slice((sha ?? '').length + 1)
    return sha === head && /^commit( \((amend|initial|merge)\))?:/.test(subject)
  } catch {
    return false
  }
}

// When the commit at HEAD was made: its committer date, clamped to the command's window.
async function commitTime($: EngineInterface, dir: string, since: number, t: number): Promise<number> {
  try {
    const out = await $.process.run(['git', '-C', dir, 'log', '-1', '--format=%ct'], { timeoutMs: 3000 })
    const text = out.stdout.trim()
    if (out.exitCode !== 0 || !/^\d+$/.test(text)) return t
    return Math.min(t, Math.max(since, Number(text) * 1000))
  } catch {
    return t
  }
}

// The PRs on a branch, by URL, with when each was created.
async function prsOn($: EngineInterface, dir: string, branch: string, repo: string | null): Promise<Map<string, number> | null> {
  const argv = ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'url,createdAt', '--limit', '20']
  if (repo !== null) argv.push('--repo', repo)
  try {
    const out = await $.process.run(argv, { timeoutMs: 8000, cwd: dir })
    if (out.exitCode !== 0) return null
    const found = new Map<string, number>()
    for (const pr of JSON.parse(out.stdout) as { url?: string; createdAt?: string }[]) {
      const at = Date.parse(pr.createdAt ?? '')
      if (typeof pr.url === 'string' && Number.isFinite(at)) found.set(pr.url, at)
    }
    return found
  } catch {
    return null
  }
}

// When a PR this command opened was created, if one has appeared. GitHub reports whole
// seconds, so the command's own second counts; PRs that were there before never do.
async function newPr($: EngineInterface, w: Watch): Promise<number | null> {
  if (w.branch === null) return null
  const prs = await prsOn($, w.dir, w.branch, w.prRepo)
  if (prs === null) return null
  const floor = Math.floor(w.since / 1000) * 1000
  const times = [...prs].filter(([url, at]) => !w.existing.has(url) && at >= floor).map(([, at]) => Math.max(at, w.since))
  return times.length === 0 ? null : Math.min(...times)
}

// Background commit and PR commands finish later, out of sight of this hook:
// one watcher each, polling for up to ten minutes.
const watchers = new Map<string, Timer>()

function stopWatchers() {
  for (const w of watchers.values()) w.cancel()
  watchers.clear()
}

type Watch = {
  key: string
  id: string
  dir: string
  since: number
  head: string | null
  wantsCommit: boolean
  wantsPr: boolean
  branch: string | null
  prRepo: string | null
  existing: Set<string>
}

function watchBackground($: EngineInterface, w: Watch) {
  let polls = 0
  let done = false
  const timer: Timer = $.clock.every(10_000, () => {
    void poll().catch(() => undefined)
  })
  // Each watcher cancels only its own timer, and forgets only its own entry.
  const stop = () => {
    done = true
    timer.cancel()
    if (watchers.get(w.key) === timer) watchers.delete(w.key)
  }
  const poll = async () => {
    if (done) return
    polls += 1
    const r = await read($, run)
    if (r === null || r.id !== w.id || r.endedAt !== null || polls > 60) return stop()
    const t = await $.clock.now()
    if (w.wantsCommit && (await landedCommit($, w.dir, w.head))) {
      await split($, w.id, COMMIT, await commitTime($, w.dir, w.since, t))
      if (!w.wantsPr) return stop()
    }
    if (w.wantsPr && w.branch !== null) {
      const at = await newPr($, w)
      if (at !== null) {
        await split($, w.id, PR, Math.min(t, at))
        return stop()
      }
    }
  }
  watchers.get(w.key)?.cancel()
  watchers.set(w.key, timer)
}

// Did a shell command change code in this repo? Its changed files go through the same
// rule as an edit's.
async function shellChangedCode($: EngineInterface, result: BashResult, root: string | null): Promise<boolean> {
  const diff = result.bashEditDiff
  if (diff === undefined) return false
  let cwd = root ?? '/'
  try {
    cwd = await $.session.cwd()
  } catch {
    // Relative paths are read against the repo root.
  }
  for (const path of changedCode(result, cwd).slice(0, 20)) {
    if (await editIsHere($, path, root)) return true
  }
  return false
}

// In a command that changed code, does a test run after something else ran first?
// (`npm test && sed -i ...` is a baseline run; `python fix.py && npm test` is not.)
export function testAfterChange(command: string): boolean {
  let before = 0
  let after = false
  walk(command, cmd => {
    if (hasTest(cmd)) {
      after = before > 0
      return HERE
    }
    before += 1
    return null
  })
  return after
}

// The session repo's root, or null when there is none.
async function rootOf($: EngineInterface): Promise<string | null> {
  try {
    const repo = await $.session.repo()
    return repo === null ? null : repo.root
  } catch {
    return null
  }
}

// Is an edited file in this repo? Under its root, or in another worktree of it.
async function editIsHere($: EngineInterface, path: string, root: string | null): Promise<boolean> {
  if (path === '' || NOT_CODE.test(path)) return false
  if (root !== null && inside(path, root)) return true
  const dir = resolvePath(path).replace(/\/[^/]*$/, '') || '/'
  const there = await commonDir($, dir)
  const here = await commonDir($, '.')
  // Another worktree of this repo counts; with no repo at all, so does a file in no repo.
  return there === here && (there !== null || root === null)
}

// Do a command's tests run in this repo?
async function testsAreHere($: EngineInterface, command: string): Promise<boolean> {
  const target = testTarget(command)
  if (target.kind === 'here') return true
  if (target.kind === 'unknown') return false
  const there = await commonDir($, target.dir)
  const here = await commonDir($, '.')
  return there !== null && there === here
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
    let commitDir: string | null = null
    let head: string | null = null
    let prDir: string | null = null
    let branch: string | null = null
    // PRs already on the branch; null when they could not be read (then no background watch).
    let existing: Set<string> | null = null
    // The session's repo root: first blood must be a change inside it.
    let root: string | null = null
    try {
      const r = await read($, run)
      await ensureTicking($, r)
      id = r !== null && r.endedAt === null ? r.id : null
      repo = r?.repo ?? null
      afterBlood = r?.splits[FIRST_BLOOD] !== null && r?.splits[FIRST_BLOOD] !== undefined
      if (id !== null && !afterBlood) root = await rootOf($)
      if (id !== null && e.tool === 'Bash') {
        command = String(e.command ?? '')
        shell = analyze(command)
        startedAt = await $.clock.now()
        // A commit that may go to the background: remember HEAD, to know a new commit when it lands.
        if (hasCommit(command)) {
          commitDir = await dirOf($, command, 'commit')
          head = commitDir === null ? null : await headOf($, commitDir)
        }
        // A PR that may go to the background: remember the PRs already on its branch.
        if (hasPr(command)) {
          prDir = await dirOf($, command, 'pr')
          if (prDir !== null) {
            branch = await prBranch($, command, prDir)
            const flag = ghRepoFlag(command)
            const prs = branch === null ? null : await prsOn($, prDir, branch, flag === null || flag === 'unknown' ? null : flag)
            existing = prs === null ? null : new Set(prs.keys())
          }
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
        // Any agent's change counts, delegated fixes included, if it is code in this repo.
        const args = e as { file_path?: unknown; notebook_path?: unknown }
        const path = String(args.file_path ?? args.notebook_path ?? '')
        if (ok && result.staged !== true && !afterBlood && (await editIsHere($, path, root))) await split($, id, FIRST_BLOOD, t)
      } else if (e.tool === 'Bash') {
        if (result.backgroundTaskId !== undefined) {
          // The task runs on in the background: a test at its start has started; its result is unseen.
          if (afterBlood && shell.startsAnyway && (await testsAreHere($, command))) await split($, id, TEST_RUN, startedAt)
          const flag = ghRepoFlag(command)
          const prRepo = flag === null || flag === 'unknown' ? null : flag
          if (commitDir !== null) {
            watchBackground($, {
              key: `${id}:${result.backgroundTaskId}:commit`,
              id,
              dir: commitDir,
              since: startedAt,
              head,
              wantsCommit: true,
              wantsPr: false,
              branch: null,
              prRepo: null,
              existing: new Set(),
            })
          }
          if (prDir !== null && branch !== null && existing !== null && (await prIsOurs($, command, prDir, undefined, repo))) {
            watchBackground($, {
              key: `${id}:${result.backgroundTaskId}:pr`,
              id,
              dir: prDir,
              since: startedAt,
              head: null,
              wantsCommit: false,
              wantsPr: true,
              branch,
              prRepo,
              existing,
            })
          }
          return ran
        }
        // An interrupted command proves nothing.
        if (result.interrupted === true) return ran
        let fresh = false
        if (ok && !afterBlood && !NOT_A_FIX.test(words(command)) && (await shellChangedCode($, result, root))) {
          await split($, id, FIRST_BLOOD, t)
          // `python fix.py && npm test`: the tests ran after this call's change.
          fresh = testAfterChange(command)
        }
        if ((afterBlood || fresh) && testStarted(shell, command, ok) && (await testsAreHere($, command))) {
          // The test-run segment ends when the tests start; their run time counts toward green.
          // Tests run after a change in the same call can't be timed apart from it.
          await split($, id, TEST_RUN, fresh ? t : startedAt)
          if (ok && shell.provesPass) await split($, id, GREEN, t)
        }
        // A commit made before a later step failed is still a commit.
        const op = result.gitOperation
        const kind = op?.commit?.kind
        if ((kind === 'committed' || kind === 'amended') && (await dirOf($, command, 'commit')) !== null) {
          await split($, id, COMMIT, t)
        }
        if (op?.pr?.action === 'created') {
          const dir = await dirOf($, command, 'pr')
          if (dir !== null && (await prIsOurs($, command, dir, op.pr.url, repo))) await split($, id, PR, t)
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
