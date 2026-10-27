# Builds the app and .pixl file icons from the artwork in branding/:
#   pixl-logo.png  (large sizes, 48 px and up)    pixl-icon.png  (small sizes, 16-32 px)
#   pixl-page*.svg (the document page behind the file icon, drawn per size)
# Artwork is shrunk in halving steps with high-quality filtering so small sizes stay smooth (a single big
# downscale aliases and looks pixelated). Writes src-tauri/icons/{icon.ico, pixl-file.ico, *.png} and the
# app's small logo/favicon in public/brand/.
#
#   npm run icons
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$tmp = Join-Path $env:TEMP 'amxpixl-icons'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $tmp | Out-Null

function New-Canvas([int]$w, [int]$h) { New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb) }

function Draw-Smooth($g, $img, [System.Drawing.RectangleF]$dst) {
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.SmoothingMode = 'HighQuality'
  $g.CompositingQuality = 'HighQuality'
  $attr = New-Object System.Drawing.Imaging.ImageAttributes
  $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)   # no dark fringe at the edges
  $g.DrawImage($img, [System.Drawing.Rectangle]::Round($dst), 0, 0, $img.Width, $img.Height, 'Pixel', $attr)
  $attr.Dispose()
}

# Halve until within 2x of the target, then one final high-quality step.
function Shrink($src, [double]$size) {
  $cur = $src
  while ($cur.Width -gt $size * 2) {
    $n = [int][Math]::Ceiling($cur.Width / 2)
    $next = New-Canvas $n $n
    $g = [System.Drawing.Graphics]::FromImage($next)
    Draw-Smooth $g $cur (New-Object System.Drawing.RectangleF 0, 0, $n, $n)
    $g.Dispose()
    if ($cur -ne $src) { $cur.Dispose() }
    $cur = $next
  }
  return $cur
}

# Renders an SVG to PNGs with Tauri's icon tool (resvg).
function Render-Svg([string]$svg, [int[]]$sizes) {
  $dir = Join-Path $tmp ([IO.Path]::GetFileNameWithoutExtension($svg))
  $ErrorActionPreference = 'Continue'   # npx writes progress to stderr
  & npx tauri icon $svg -o $dir -p ($sizes -join ',') 2>&1 | Out-Null
  if (-not (Test-Path "$dir\$($sizes[0])x$($sizes[0]).png")) { throw "Couldn't render $svg" }
  return $dir
}

function Icon-Png($art, [int]$s, [string]$pageDir, [double[]]$rect) {
  $out = New-Canvas $s $s
  $g = [System.Drawing.Graphics]::FromImage($out)
  if ($pageDir) { $page = [System.Drawing.Image]::FromFile("$pageDir\${s}x${s}.png"); $g.DrawImage($page, 0, 0, $s, $s); $page.Dispose() }
  $k = $s / $rect[3]
  $dst = New-Object System.Drawing.RectangleF ($rect[0] * $k), ($rect[1] * $k), ($rect[2] * $k), ($rect[2] * $k)
  $small = Shrink $art ($dst.Width)
  Draw-Smooth $g $small $dst
  if ($small -ne $art) { $small.Dispose() }
  $g.Dispose()
  $path = Join-Path $tmp ("{0}-{1}.png" -f ($(if ($pageDir) { 'file' } else { 'app' }), $s))
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  return $path
}

function Write-Ico([string]$out, [string[]]$pngs) {
  $imgs = foreach ($p in $pngs) { $b = [IO.File]::ReadAllBytes($p); [pscustomobject]@{ Bytes = $b; Size = [BitConverter]::ToUInt32(@($b[19], $b[18], $b[17], $b[16]), 0) } }
  $ms = New-Object IO.MemoryStream; $bw = New-Object IO.BinaryWriter($ms)
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$imgs.Count)
  $offset = 6 + 16 * $imgs.Count
  foreach ($i in $imgs) {
    $s = if ($i.Size -ge 256) { 0 } else { $i.Size }
    $bw.Write([byte]$s); $bw.Write([byte]$s); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$i.Bytes.Length); $bw.Write([uint32]$offset)
    $offset += $i.Bytes.Length
  }
  foreach ($i in $imgs) { $bw.Write($i.Bytes) }
  $bw.Flush(); [IO.File]::WriteAllBytes($out, $ms.ToArray())
}

$logo = [System.Drawing.Image]::FromFile("$root\branding\pixl-logo.png")
$icon = [System.Drawing.Image]::FromFile("$root\branding\pixl-icon.png")
$page = Render-Svg "$root\branding\pixl-page.svg" @(48, 64, 128, 256)
$page32 = Render-Svg "$root\branding\pixl-page-32.svg" @(24, 32)
$page16 = Render-Svg "$root\branding\pixl-page-16.svg" @(16)

# App icon: the whole square. File icon: the artwork placed on the page at [x, y, size] of a [viewBox] grid.
$app = @(16, 24, 32 | ForEach-Object { Icon-Png $icon $_ $null @(0, 0, 1, 1) }) + @(48, 64, 128, 256 | ForEach-Object { Icon-Png $logo $_ $null @(0, 0, 1, 1) })
$file = @(Icon-Png $icon 16 $page16 @(3.5, 5.5, 9, 16)) + @(24, 32 | ForEach-Object { Icon-Png $icon $_ $page32 @(7, 10, 18, 32) }) +
  @(48, 64, 128, 256 | ForEach-Object { Icon-Png $logo $_ $page @(58, 80, 152, 256) })

Write-Ico "$root\src-tauri\icons\icon.ico" $app
Write-Ico "$root\src-tauri\icons\pixl-file.ico" $file
Copy-Item "$tmp\app-32.png" "$root\src-tauri\icons\32x32.png" -Force
Copy-Item "$tmp\app-64.png" "$root\src-tauri\icons\64x64.png" -Force
Copy-Item "$tmp\app-128.png" "$root\src-tauri\icons\128x128.png" -Force
Copy-Item "$tmp\file-256.png" "$root\branding\pixl-file-256.png" -Force
Copy-Item "$tmp\app-32.png" "$root\public\brand\favicon-32.png" -Force
# The top bar shows the small icon at 26 CSS px; 64 px keeps it sharp on high-DPI screens.
$i64 = Icon-Png $icon 64 $null @(0, 0, 1, 1)
Copy-Item $i64 "$root\public\brand\pixl-icon-64.png" -Force
$l256 = Icon-Png $logo 256 $null @(0, 0, 1, 1)
Copy-Item $l256 "$root\public\brand\pixl-logo-256.png" -Force
$logo.Dispose(); $icon.Dispose()
Write-Host "Icons written. Previews in $tmp"
