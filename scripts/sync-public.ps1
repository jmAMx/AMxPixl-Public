# Carries new commits from main onto public-main, the history that's published to the public repository
# (jmAMx/AMxPixl-public). Each one keeps its files, message, author and date, and version commits ("v1.2.3: ...")
# get a v1.2.3 tag. Nothing is pushed; scripts/release.ps1 does that.
#
#   npm run sync-public
#
# public-main is main's history with specific hardware taken out of the docs and messages (the public notes say
# "older hardware" or give requirements instead). A commit that names it again stops the sync, so reword it first.
# The words to look for live in this clone's git config, not in the repository:
#   git config pixl.publicBlocklist "<regular expression>"
$ErrorActionPreference = 'Continue'
Set-Location (Split-Path $PSScriptRoot -Parent)
$banned = git config --get pixl.publicBlocklist
if (-not $banned) { Write-Warning 'No pixl.publicBlocklist in git config, so commits are copied without checking their wording.' }
$marker = 'refs/public-sync/main'

$from = git rev-parse --verify -q $marker
if (-not $from) { throw "No $marker ref, so there's no record of what public-main already has." }
if ((git rev-parse 'public-main^{tree}') -ne (git rev-parse "$from^{tree}")) { throw 'public-main and main had different files at the last sync.' }
$commits = @(git rev-list --reverse "$from..main")
if (-not $commits.Count) { Write-Host 'public-main is up to date.'; return }

$parent = git rev-parse public-main
foreach ($c in $commits) {
  $short = git rev-parse --short $c
  if (@(git rev-list --parents -n 1 $c).Split(' ').Count -gt 2) { throw "$short is a merge; public-main only takes a straight line of commits." }
  if ($banned) {
    $found = git grep -I -n -i -E $banned $c -- . ':!package-lock.json' ':!src-tauri/Cargo.lock'
    if ($found) { throw "$short names specific hardware:`n$($found -join "`n")" }
    if ((git log -1 --format=%B $c) -match $banned) { throw "$short's message names specific hardware." }
  }
  foreach ($k in 'NAME', 'EMAIL', 'DATE') {
    $f = @{ NAME = 'n'; EMAIL = 'e'; DATE = 'I' }[$k]
    Set-Item "env:GIT_AUTHOR_$k" (git log -1 --format="%a$f" $c)
    Set-Item "env:GIT_COMMITTER_$k" (git log -1 --format="%c$f" $c)
  }
  # cmd passes the message between the two git commands as raw bytes (PowerShell would re-encode it).
  $tree = git rev-parse "$c^{tree}"
  $new = cmd /c "git log -1 --format=%B $c | git commit-tree $tree -p $parent"
  if ($LASTEXITCODE -ne 0 -or -not $new) { throw "Couldn't copy $short." }
  $subject = git log -1 --format=%s $c
  if ($subject -match '^v(\d+(\.\d+)+):' -and -not (git tag --list "v$($Matches[1])")) { git tag -a "v$($Matches[1])" -m "AMxPixl $($Matches[1])" $new }
  Write-Host "$short -> $(git rev-parse --short $new)  $subject"
  $parent = $new
}
foreach ($k in 'NAME', 'EMAIL', 'DATE') { Remove-Item "env:GIT_AUTHOR_$k", "env:GIT_COMMITTER_$k" -ErrorAction SilentlyContinue }
git update-ref refs/heads/public-main $parent
git update-ref $marker main
Write-Host "public-main now has $($commits.Count) more commit(s)."
