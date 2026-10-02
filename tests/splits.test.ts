import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  analyze,
  asFinished,
  board,
  clock,
  fold,
  gitTarget,
  ownerRepo,
  PHASES,
  segment,
  sumOfBest,
  testStarted,
} from '../hooks/register'
import type { Finished } from '../types'

const person = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })
const KEY = 'pr'
const KEY_COMMIT = 'commit'

type Best = { pb: { total: number; splits: (number | null)[] } | null; gold: (number | null)[]; history: unknown[] }

// The world beneath the plugin: a clock the test moves, a store it can read, the repo, toasts.
function world(on: On, below = '', remote: string | null = null) {
  const time = mock.clock(on, { now: 1_000_000 })
  // What the plugins below draw above the prompt: an empty row, or another band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (below === '' ? h(Box, {}) : h(Text, { key: 'other' }, below)) as never
  })
  const store: Record<string, unknown> = {}
  const toasts: string[] = []
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.delete', (_$, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('session.repo', () => ({ value: { root: '/work/acme', remote, internal: false, name: 'acme' } }))
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  return { time, store, toasts }
}

// The board for a finish line, folded from the per-run keys the mod wrote; undefined if none.
function boardOf(store: Record<string, unknown>, mode: string): Best | undefined {
  const runs = Object.entries(store)
    .filter(([k]) => k.startsWith(`run:${mode}:`))
    .map(([, v]) => asFinished(v))
    .filter((f): f is Finished => f !== null)
    .sort((a, b) => a.startedAt - b.startedAt)
  return runs.length === 0 ? undefined : (board(runs) as Best)
}

const bash = (extra: Record<string, unknown> = {}) => ({ result: { stdout: '', stderr: '', interrupted: false, ...extra } })
const committed = bash({ gitOperation: { commit: { sha: 'abc', kind: 'committed' } } })
const prCreated = bash({ gitOperation: { pr: { number: 7, action: 'created' } } })
const fail = { isError: true as const, result: 'exit 1', text: 'exit 1' }

const splitsCommand = (args: string) =>
  ({ command: 'splits', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never

test('a full run splits every phase and records a PB', async ($, on) => {
  const { time, store, toasts } = world(on)
  let failNext = true
  on('tool.call', async (_$, e) => {
    if (e.tool !== 'Bash') return { result: { staged: false } }
    const command = String(e.command)
    if (command === 'npm test') {
      await time.advance(4_000) // the tests take time to run
      if (failNext) {
        failNext = false
        return fail
      }
      return bash()
    }
    if (command.includes('git commit')) return committed
    if (command.includes('gh pr create')) return prCreated
    return bash()
  })
  await $.prompt.submit(person('fix the bug'))
  await time.advance(10_000)
  await $.tool.call({ tool: 'Read', file_path: '/work/acme/a.ts' })
  await time.advance(20_000)
  await $.tool.call({ tool: 'Edit', file_path: '/work/acme/a.ts', old_string: 'a', new_string: 'b' })
  await time.advance(5_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' }) // test run at 35s, fails at 39s
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' }) // passes at 44s
  await time.advance(5_000)
  await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m fix' })
  await time.advance(5_000)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })

  const best = boardOf(store, KEY) as Best
  expect(best.pb?.total).toBe(54_000)
  expect(best.pb?.splits).toEqual([10_000, 30_000, 35_000, 44_000, 49_000, 54_000])
  expect(toasts.join(' ')).toMatch(/New PB on acme/)
  const table = await $.command.run(splitsCommand(''))
  expect(String((table as { text?: string }).text)).toMatch(/Personal best: 0:54/)
})

test('fake passes do not count as green', async ($, on) => {
  const { time, store } = world(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' && String(e.command).includes('git commit') ? committed : bash()))
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  await time.advance(1_000)
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test || true' })
  await $.tool.call({ tool: 'Bash', command: 'npm test; echo done' })
  await $.tool.call({ tool: 'Bash', command: 'npm test > /tmp/t.log 2>&1 & true' })
  await $.tool.call({ tool: 'Bash', command: 'npm test --help' })
  await $.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' })
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "make npm test pass"' })
  const best = boardOf(store, KEY_COMMIT) as Best
  expect(best.pb?.splits[3]).toBe(null)
  expect(best.pb?.splits[4]).toBe(3_000)
})

test('a backgrounded command proves nothing', async ($, on) => {
  const { time, store } = world(on)
  on('tool.call', () => bash({ backgroundTaskId: 'b1', gitOperation: { commit: { sha: 'x', kind: 'committed' } } }))
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  expect(boardOf(store, KEY_COMMIT)).toBe(undefined)
})

test('tests before the first edit are recon, and edit-before-read never goes negative', async ($, on) => {
  const { time, store } = world(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' && String(e.command).includes('git commit') ? committed : bash()))
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  await time.advance(2_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await time.advance(3_000)
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  await time.advance(4_000)
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })
  const best = boardOf(store, KEY_COMMIT) as Best
  expect(best.pb?.splits).toEqual([9_000, 5_000, null, null, 10_000, null])
  expect(best.gold.every(g => g === null || g > 0)).toBe(true)
})

test('a delegated fix counts: subagent edit, tests and commit; but not its reads', async ($, on) => {
  const { time, store } = world(on)
  on('tool.call', (_$, e) => {
    if (e.tool !== 'Bash') return { result: { staged: false } }
    return String(e.command).includes('git commit') ? committed : bash()
  })
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  const sub = { agentId: 'sub-1' }
  await $.tool.call({ tool: 'Read', file_path: '/x', ...sub } as never)
  await time.advance(1_000)
  await $.tool.call({ tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b', ...sub } as never)
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'npm test', ...sub } as never)
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'git commit -am x', ...sub } as never)
  const best = boardOf(store, KEY_COMMIT) as Best
  expect(best.pb?.splits).toEqual([null, 1_000, 2_000, 2_000, 3_000, null])
})

test('a run that changed no code is history, not a record', async ($, on) => {
  const { time, store } = world(on)
  on('tool.call', () => committed)
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'git commit -am x' })
  const best = boardOf(store, KEY_COMMIT) as Best
  expect(best.pb).toBe(null)
  expect(best.gold.every(g => g === null)).toBe(true)
  expect(best.history.length).toBe(1)
})

test('the finish line is exact: amend finishes commit mode, a PR does not, cherry-pick never splits', async ($, on) => {
  const { time, store } = world(on)
  on('tool.call', (_$, e) => {
    if (e.tool !== 'Bash') return { result: { staged: false } }
    const c = String(e.command)
    if (c.startsWith('gh pr')) return prCreated
    if (c.startsWith('git cherry-pick')) return bash({ gitOperation: { commit: { sha: 'x', kind: 'cherry-picked' } } })
    return bash({ gitOperation: { commit: { sha: 'y', kind: 'amended' } } })
  })
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  await time.advance(1_000)
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  await $.tool.call({ tool: 'Bash', command: 'git cherry-pick abc' })
  expect(boardOf(store, KEY_COMMIT)).toBe(undefined)
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'git commit --amend --no-edit' })
  expect((boardOf(store, KEY_COMMIT) as Best).pb?.total).toBe(2_000)
  expect(store['finish-on']).toBe('commit')
})

test('git milestones aimed at another repo are not credited', async ($, on) => {
  const { time, store } = world(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? committed : { result: { staged: false } }))
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'git -C /other/repo commit -am x' })
  expect(boardOf(store, KEY_COMMIT)).toBe(undefined)
})

test('commit and PR finish lines keep separate records; notifications start no run', async ($, on) => {
  const { time, store } = world(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? committed : { result: { staged: false } }))
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  await time.advance(7_000)
  await $.tool.call({ tool: 'Bash', command: 'git commit -am wip' })
  expect((boardOf(store, KEY_COMMIT) as Best).pb?.total).toBe(7_000)
  expect(boardOf(store, KEY)).toBe(undefined)
  await $.prompt.submit({ text: 'done', wait: false, origin: { kind: 'task-notification' } })
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'git commit -am again' })
  expect((boardOf(store, KEY_COMMIT) as Best).history.length).toBe(1)
  await $.command.run(splitsCommand('clear'))
  expect(boardOf(store, KEY_COMMIT)).toBe(undefined)
})

test('a reset during an in-flight tool leaves the new run alone', async ($, on) => {
  const { time, store } = world(on)
  let release: () => void = () => {}
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Bash' && String(e.command) === 'slow') {
      await new Promise<void>(resolve => (release = resolve))
      return committed
    }
    return bash()
  })
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  const inFlight = $.tool.call({ tool: 'Bash', command: 'slow' })
  await time.advance(100)
  await $.command.run(splitsCommand('reset'))
  await $.command.run(splitsCommand('start'))
  release()
  await inFlight
  expect(boardOf(store, KEY_COMMIT)).toBe(undefined)
})

test('pure helpers', () => {
  const empty = { pb: null, gold: PHASES.map(() => null), history: [] }
  const first = fold(empty, [10, 30, null, null, 40, 50], 50, 'd1')
  const second = fold(first, [5, 40, null, null, 50, 60], 60, 'd2')
  expect(second.pb?.total).toBe(50)
  expect(second.gold[0]).toBe(5)
  expect(second.gold[1]).toBe(20)
  expect(second.history.length).toBe(2)
  // A zero-length segment is never gold; neither is a first phase reached with nothing before it,
  // nor one run out of order (a read just after an edit is not a fast recon).
  expect(fold(empty, [10, 10, null, null, 20, 30], 30, 'd').gold[1]).toBe(null)
  expect(fold(empty, [null, 10, null, null, 20, null], 20, 'd').gold[1]).toBe(null)
  expect(fold(empty, [5100, 5000, null, null, 9000, null], 9000, 'd').gold[0]).toBe(null)

  const pass = (c: string) => analyze(c).provesPass
  const runs = (c: string) => analyze(c).runsTest
  expect(pass('cd app && npx vitest run')).toBe(true)
  expect(pass('FOO=1 timeout 60 pytest -q')).toBe(true)
  expect(pass('uv run pytest')).toBe(true)
  expect(pass('cd app; npm test')).toBe(true)
  expect(pass('(cd app && npm test)')).toBe(true)
  expect(pass('pnpm --filter app test')).toBe(true)
  expect(pass('npm --prefix app test')).toBe(true)
  expect(pass('npx -y vitest run')).toBe(true)
  expect(pass('npm test 2>&1 | tail -5 && echo')).toBe(false)
  expect(pass('npm test && git commit -m x')).toBe(true)
  expect(pass('npm test || true')).toBe(false)
  expect(pass('npm test; echo done')).toBe(false)
  expect(pass('npm test & true')).toBe(false)
  expect(pass('pytest --collect-only')).toBe(false)
  expect(pass('cargo test --no-run')).toBe(false)
  expect(pass('npx tsc --noEmit')).toBe(false)
  expect(runs('npx tsc --noEmit')).toBe(true)
  expect(runs('echo npm test')).toBe(false)
  expect(runs('git log -S "npm test"')).toBe(false)
  expect(runs('yarn check')).toBe(false)
  expect(pass('echo done # && npm test')).toBe(false)
  expect(pass('pytest "--collect-only"')).toBe(false)
  expect(pass('pytest --version')).toBe(false)
  expect(pass('go test -list .')).toBe(false)
  expect(pass('npx playwright test --list')).toBe(false)
  expect(pass('npx vitest list')).toBe(false)
  expect(pass('npm run tests')).toBe(true)
  expect(pass('npm test && git commit -m "Fix --help crash"')).toBe(true)
  expect(pass('npm test # do not pass --collect-only')).toBe(true)
  expect(pass('./gradlew :app:compileTestKotlin :app:testDebugUnitTest')).toBe(true)
  expect(pass('pytest --fixtures')).toBe(false)
  expect(pass('npx jest --showConfig')).toBe(false)
  expect(pass('make test-fixtures')).toBe(false)
  expect(pass('make tests')).toBe(true)
  expect(pass('yarn workspace app test')).toBe(true)
  expect(pass('npm run dev &\nnpx playwright test')).toBe(true)
  expect(pass('cd app && (npm test)')).toBe(true)
  expect(testStarted(analyze('cd app && (npm test)'), 'cd app && (npm test)', true)).toBe(true)
  const setE = 'set -e\nnpm run build\nnpm test'
  expect(testStarted(analyze(setE), setE, false)).toBe(false)
  expect(pass('node --test')).toBe(true)
  // A test behind a failed build never started.
  const built = 'npm run build && npm test'
  expect(testStarted(analyze(built), built, false)).toBe(false)
  expect(testStarted(analyze(built), built, true)).toBe(true)
  expect(testStarted(analyze('npm test'), 'npm test', false)).toBe(true)

  expect(gitTarget('git commit -am x')).toEqual({ kind: 'here' })
  expect(gitTarget('git -C . commit -am x')).toEqual({ kind: 'here' })
  expect(gitTarget('git commit -C HEAD -m x')).toEqual({ kind: 'here' })
  expect(gitTarget('git -C /other commit -am x')).toEqual({ kind: 'dir', dir: '/other' })
  expect(gitTarget('cd /other/repo && git commit -am x')).toEqual({ kind: 'dir', dir: '/other/repo' })
  expect(gitTarget('GIT_DIR=/o/.git git commit -am x')).toEqual({ kind: 'unknown' })
  expect(gitTarget('git commit -m "use git -C carefully"')).toEqual({ kind: 'here' })
  expect(gitTarget('git -C . status && git -C /other commit -am x')).toEqual({ kind: 'dir', dir: '/other' })
  expect(gitTarget('git -C . -C /other commit -am x')).toEqual({ kind: 'unknown' })
  expect(gitTarget('git commit -am x && cd /tmp')).toEqual({ kind: 'here' })
  expect(gitTarget('cd "packages/app" && git commit -am x')).toEqual({ kind: 'dir', dir: 'packages/app' })
  expect(gitTarget('(cd /other && make) && git commit -am x')).toEqual({ kind: 'unknown' })
  expect(gitTarget('pushd /other && git commit -am x')).toEqual({ kind: 'unknown' })
  expect(ownerRepo('https://user:tok@github.com/Org/Repo.git')).toBe('org/repo')
  expect(ownerRepo('git@github.com-work:org/repo.git')).toBe('org/repo')
  expect(ownerRepo('ssh://git@ssh.github.com:22/org/repo.git')).toBe('org/repo')
  expect(ownerRepo('https://github.com/org/repo/pull/7')).toBe('org/repo')
  expect(asFinished({ nope: 1 })).toBe(null)
  expect(asFinished({ id: 'a', date: 'd', startedAt: 1, total: NaN, splits: [null, null, null, null, null, null] })).toBe(null)
  expect(segment([10, null, 40], 2)).toBe(30)
  expect(segment([20, 5, null], 0)).toBe(15)
  expect(sumOfBest([1, null])).toBe(null)
  expect(clock(3_725_000)).toBe('1:02:05')
  expect(clock(65_000)).toBe('1:05')
})

test('the band shows the clock and splits on each surface', async ($, on) => {
  const { time } = world(on)
  on('tool.call', () => bash())
  await $.prompt.submit(person('go'))
  await time.advance(12_000)
  await $.tool.call({ tool: 'Read', file_path: '/work/acme/a.ts' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'speedrun-splits',
      surface,
      component: 'AbovePrompt',
      props: { bodyColumns: 120, hasSurvey: false },
    } as never)
    expect(await ui.find({ type: 'Text', text: /recon/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /next: first blood/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the band composes with what other plugins draw above the prompt', async ($, on) => {
  const { time } = world(on, 'other band')
  on('tool.call', () => bash())
  await $.prompt.submit(person('go'))
  await time.advance(3_000)
  await $.tool.call({ tool: 'Read', file_path: '/a' })
  const ui = await $.ui.mount({
    plugin: 'speedrun-splits',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { bodyColumns: 120, hasSurvey: false },
  } as never)
  expect(await ui.find({ type: 'Text', text: /recon/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /other band/ })).toBeDefined()
  await ui.unmount()
})

test('another session’s run saved meanwhile is kept, and the slower one never replaces the PB', async ($, on) => {
  const { time, store } = world(on)
  // Another session finished a faster run while this one was going.
  store['run:commit:%2Fwork%2Facme:other'] = {
    id: 'other',
    date: '2026-01-01T00:00:00.000Z',
    startedAt: 1,
    total: 1_500,
    splits: [null, 500, null, null, 1_500, null],
  }
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? committed : { result: { staged: false } }))
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  await time.advance(1_000)
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  await time.advance(4_000)
  await $.tool.call({ tool: 'Bash', command: 'git commit -am x' })
  const best = boardOf(store, KEY_COMMIT) as Best
  expect(best.history.length).toBe(2)
  expect(best.pb?.total).toBe(1_500)
})

test('a PR opened on another repo is not this run’s finish', async ($, on) => {
  const { time, store } = world(on, '', 'git@github.com:org/acme.git')
  on('tool.call', (_$, e) => {
    if (e.tool !== 'Bash') return { result: { staged: false } }
    const url = String(e.command).includes('other') ? 'https://github.com/org/other/pull/1' : 'https://github.com/org/acme/pull/2'
    return bash({ gitOperation: { pr: { number: 1, action: 'created', url } } })
  })
  await $.prompt.submit(person('go'))
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill # other' })
  expect(boardOf(store, KEY)).toBe(undefined)
  await time.advance(1_000)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
  expect((boardOf(store, KEY) as Best).pb?.total).toBe(2_000)
})

test('a backgrounded commit is picked up when it lands', async ($, on) => {
  const { time, store } = world(on)
  let head = 'aaa'
  on('process.run', (_$, e) => {
    const argv = (e as { argv?: string[] }).argv ?? []
    const stdout = argv.includes('log') ? `${Math.floor(1_006_000 / 1000)}\n` : argv.includes('HEAD') ? `${head}\n` : '/work/acme/.git\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? bash({ backgroundTaskId: 'b1' }) : { result: { staged: false } }))
  await $.command.run(splitsCommand('finish-on commit'))
  await $.prompt.submit(person('go'))
  await $.tool.call({ tool: 'Edit', file_path: '/a', old_string: 'a', new_string: 'b' })
  await time.advance(5_000)
  await $.tool.call({ tool: 'Bash', command: 'git commit -am x', run_in_background: true } as never)
  // No new commit yet: an old HEAD never counts.
  await time.advance(10_000)
  expect(boardOf(store, KEY_COMMIT)).toBe(undefined)
  head = 'bbb'
  await time.advance(10_000)
  expect((boardOf(store, KEY_COMMIT) as Best).pb?.total).toBe(6_000)
})
