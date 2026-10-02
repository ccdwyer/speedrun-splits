export type FinishOn = 'pr' | 'commit'

// One timed attempt. `splits[i]` is ms from the start when phase i was reached,
// or null while not reached. `id` tells this run from one that replaced it.
export type Run = {
  id: string
  repo: string
  repoName: string
  finishOn: FinishOn
  startedAt: number
  splits: (number | null)[]
  endedAt: number | null
}

// One finished run as the store keeps it, under a key of its own.
export type Finished = { id: string; date: string; startedAt: number; total: number; splits: (number | null)[] }

// The board for a repo and finish line, folded from its finished runs.
export type Best = {
  pb: { total: number; splits: (number | null)[]; id?: string } | null
  gold: (number | null)[]
  goldIds?: (string | null)[]
  history: { id?: string; date: string; total: number; splits: (number | null)[] }[]
}

declare module 'claude-code' {
  interface PluginState {
    'speedrun-splits': {
      run: Run | null
      now: number
      hidden: boolean
      finishOn: FinishOn
      // The board as it stood when the current run started: what it is compared to.
      record: Best | null
    }
  }
}
