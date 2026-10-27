# Publishes the installer you've already built (npm run package) as a GitHub release on the public
# jmAMx/AMxPixl-releases repository, with this version's CHANGELOG section as the notes. The source code stays in
# the private repository; Pixl's Check for Updates reads the public one.
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
$repo = 'jmAMx/AMxPixl-releases'

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

# Release notes: this version's section of CHANGELOG.md.
$log = Get-Content CHANGELOG.md -Raw -Encoding UTF8
$m = [regex]::Match($log, "(?ms)^## $([regex]::Escape($version))\s*\r?\n(.*?)(?=^## |\z)")
if (-not $m.Success) { throw "CHANGELOG.md has no '## $version' section." }
$notes = Join-Path $env:TEMP "amxpixl-notes-$version.md"
[IO.File]::WriteAllText($notes, $m.Groups[1].Value.Trim() + "`n`nInstall: download **$($installer.Name)** and run it. It replaces your current version and keeps your settings.`n", (New-Object System.Text.UTF8Encoding $false))

# The public repository is created the first time.
& $gh repo view $repo *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating public repository $repo..."
  & $gh repo create $repo --public --description 'Downloads for AMxPixl (Pixl Editor), a lightweight non-destructive image editor for Windows.' --add-readme
  if ($LASTEXITCODE -ne 0) { throw "Couldn't create $repo." }
}

& $gh release view $tag --repo $repo *> $null
if ($LASTEXITCODE -eq 0) { throw "$tag is already published on $repo. Bump the version in package.json first." }

$ghArgs = @('release', 'create', $tag, $installer.FullName, '--repo', $repo, '--title', "AMxPixl $version", '--notes-file', $notes)
if ($Draft) { $ghArgs += '--draft' }
& $gh @ghArgs
if ($LASTEXITCODE -ne 0) { throw 'Publishing the release failed.' }

# Mark the same version in the private source repository.
if (-not (git tag --list $tag)) { git tag -a $tag -m "AMxPixl $version"; git push origin $tag }
Write-Host "Published ${tag}: https://github.com/$repo/releases/tag/$tag"
