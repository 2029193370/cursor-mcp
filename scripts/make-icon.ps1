param(
    [Parameter(Mandatory=$true)][string]$Src,
    [Parameter(Mandatory=$true)][string]$Dst
)

Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Image]::FromFile($Src)
Write-Host ("source: {0}x{1}" -f $img.Width, $img.Height)

$size = [Math]::Min($img.Width, $img.Height)
$cx = [int](($img.Width - $size) / 2)
$cy = [int](($img.Height - $size) / 2)

$square = New-Object System.Drawing.Bitmap $size, $size
$gSq = [System.Drawing.Graphics]::FromImage($square)
$gSq.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $size, $size), $cx, $cy, $size, $size, [System.Drawing.GraphicsUnit]::Pixel)
$gSq.Dispose()

$out = New-Object System.Drawing.Bitmap 128, 128
$g = [System.Drawing.Graphics]::FromImage($out)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($square, 0, 0, 128, 128)
$g.Dispose()

$ms = New-Object System.IO.MemoryStream
$out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$tmp = Join-Path $env:TEMP 'cursor-mcp-icon.png'
[System.IO.File]::WriteAllBytes($tmp, $ms.ToArray())
$ms.Dispose()
$out.Dispose()
$square.Dispose()
$img.Dispose()

Copy-Item -LiteralPath $tmp -Destination $Dst -Force
Remove-Item -LiteralPath $tmp -Force
Write-Host ("wrote: {0}" -f $Dst)
