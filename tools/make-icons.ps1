# Erzeugt die Erweiterungs-Icons (16/32/48/128 px) im eigenständigen blauen QUANTUM-Design
param([string]$OutDir = (Join-Path $PSScriptRoot '..\icons'))

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

foreach ($s in 16, 32, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Abgerundetes Squircle mit tiefblauem bis cyanblauem Quantum-Verlauf
    $r = [float]($s * 0.24)
    $w = [float]($s - 1)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $path.AddArc($w - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $path.AddArc($w - 2 * $r, $w - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $path.AddArc(0, $w - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $path.CloseFigure()

    $c1 = [System.Drawing.Color]::FromArgb(255, 14, 165, 233)  # #0ea5e9 (Electric Cyan-Blue)
    $c2 = [System.Drawing.Color]::FromArgb(255, 30, 58, 138)   # #1e3a8a (Deep Quantum Navy)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
        [System.Drawing.PointF]::new(0, 0),
        [System.Drawing.PointF]::new($s, $s),
        $c1,
        $c2
    )
    $g.FillPath($brush, $path)

    # Quantum-Orbitalring (helles Cyan/Weiß)
    $ringPenWidth = [Math]::Max(1.4, $s * 0.085)
    $ringPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(235, 224, 242, 254), $ringPenWidth)
    $ringInset = [float]($s * 0.16)
    $ringSize = [float]($s - 2 * $ringInset)
    $g.DrawEllipse($ringPen, $ringInset, $ringInset, $ringSize, $ringSize)

    # Zentraler Download-Pfeil im Quantum-Ring
    $white = [System.Drawing.Brushes]::White
    $cx = $s / 2.0
    $shaftW = [Math]::Max(1.6, $s * 0.13)
    $top = $s * 0.29
    $mid = $s * 0.52
    $tip = $s * 0.70
    $headW = $s * 0.38
    $g.FillRectangle($white, [float]($cx - $shaftW / 2), [float]$top, [float]$shaftW, [float]($mid - $top + 1))
    $pts = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new($cx - $headW / 2, $mid),
        [System.Drawing.PointF]::new($cx + $headW / 2, $mid),
        [System.Drawing.PointF]::new($cx, $tip)
    )
    $g.FillPolygon($white, $pts)

    $file = Join-Path $OutDir "icon$s.png"
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $ringPen.Dispose(); $brush.Dispose(); $path.Dispose(); $g.Dispose(); $bmp.Dispose()
    Write-Host "Erstellt: $file"
}
