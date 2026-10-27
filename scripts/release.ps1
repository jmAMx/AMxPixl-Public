# Publishes the installer you've already built (npm run package) as a GitHub release of jmAMx/AMxPixl, tagged with
# the version in package.json and with that version's CHANGELOG section as the notes. Pixl's Check for Updates reads
# these releases (the repository has to be public for that).
#
#   npm run release            publish the version in package.json
#   npm run release -- -Draft  create it as a draft to review on GitHub first
#
# Needs the GitHub CLI signed in once:  gh auth login
param([switch]$Draft)
# Native commands report through $LASTEXITCODE (checked below); 'Stop' would turn their stderr into errors.
$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$repo = 'jmAMx/AMxPixl'

$gh = Get-Command gh -ErrorAction SilentlyContinue
if (-not $gh) { $gh = Get-Command 'C:\Program Files\GitHub CLI\gh.exe' -ErrorAction SilentlyContinue }
if (-not $gh) { throw 'GitHub CLI not found. Install it with: winget install GitHub.cli' }
$gh = $gh.Source
& $gh auth status *> $null
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI is not signed in. Run: gh auth login' }

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
$installer = Get-ChildItem "src-tauri\target\release\bundle\nsis\AMxPixl_${version}_x64-setup.exe" -ErrorAction SilentlyContinue
if (-not $installer) { throw "No installer for $version. Build it first: npm run package" }
if (git status --porcelain) { throw 'There are uncommitted changes. Commit them first so the release matches its tag.' }

# Release notes: this version's section of CHANGELOG.md.
$log = Get-Content CHANGELOG.md -Raw -Encoding UTF8
$m = [regex]::Match($log, "(?ms)^## $([regex]::Escape($version))\s*\r?\n(.*?)(?=^## |\z)")
if (-not $m.Success) { throw "CHANGELOG.md has no '## $version' section." }
$notes = Join-Path $env:TEMP "amxpixl-notes-$version.md"
[IO.File]::WriteAllText($notes, $m.Groups[1].Value.Trim() + "`n`nInstall: download **$($installer.Name)** and run it. It replaces your current version and keeps your settings.`n", (New-Object System.Text.UTF8Encoding $false))

$visibility = & $gh repo view $repo --json visibility --jq .visibility
if ($visibility -ne 'PUBLIC') { Write-Warning "$repo is ${visibility}: the release will be published, but Check for Updates can only see releases of a public repository." }

& $gh release view $tag --repo $repo *> $null
if ($LASTEXITCODE -eq 0) { throw "$tag is already published. Bump the version in package.json first." }

# Tag the commit being released, then publish the installer against that tag.
if (-not (git tag --list $tag)) { git tag -a $tag -m "AMxPixl $version" }
git push origin $tag
if ($LASTEXITCODE -ne 0) { throw "Couldn't push the $tag tag." }

$ghArgs = @('release', 'create', $tag, $installer.FullName, '--repo', $repo, '--title', "AMxPixl $version", '--notes-file', $notes, '--verify-tag')
if ($Draft) { $ghArgs += '--draft' }
& $gh @ghArgs
if ($LASTEXITCODE -ne 0) { throw 'Publishing the release failed.' }
Write-Host "Published ${tag}: https://github.com/$repo/releases/tag/$tag"
