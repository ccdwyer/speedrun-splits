# Privacy

Timing runs entirely on your machine, and run times and personal bests are kept in Claude Code's local plugin store. The one exception: when a command runs `gh pr create`, the mod uses your existing GitHub CLI (`gh`) login to ask GitHub which pull requests are on that branch and which repo is this checkout's fork parent, so it can tell when the PR lands and whether it belongs to this run. Those requests go only to GitHub (or your GitHub Enterprise host), under your own account, and send nothing but the repo and branch names. Nothing is sent anywhere else.

The mod collects no analytics or telemetry, and its author receives no data from it.

Questions: https://github.com/ccdwyer/speedrun-splits/issues
