# FOAR installer for Windows.
#
#   irm https://josmanvis.github.io/FOAR/install.ps1 | iex
#
# Environment: FOAR_VERSION (default: latest), FOAR_INSTALL (default: ~\.foar),
# FOAR_BIN_DIR, FOAR_DOWNLOAD_URL, FOAR_UNINSTALL=1, NO_COLOR.
#
# Downloads the release zip for this machine from GitHub, checks its SHA-256,
# puts foar.exe in ~\.foar\bin and adds that to your user PATH, and to this
# session's, so `foar` works right away.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# The user PATH as stored (keeping %VARIABLES% unexpanded), and written back as
# REG_EXPAND_SZ; then a no-op SetEnvironmentVariable tells Windows it changed.
function Get-UserPath {
    $key = Get-Item -Path 'HKCU:\Environment'
    [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
}
function Set-UserPath($value) {
    Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value $value -Type ExpandString
    [Environment]::SetEnvironmentVariable('FOAR_INSTALLER_TMP', '1', 'User')
    [Environment]::SetEnvironmentVariable('FOAR_INSTALLER_TMP', $null, 'User')
}

function Install-Foar {
    $Repo = 'https://github.com/josmanvis/FOAR'
    $Base = if ($env:FOAR_DOWNLOAD_URL) { $env:FOAR_DOWNLOAD_URL } else { "$Repo/releases" }
    $Version = if ($env:FOAR_VERSION) { $env:FOAR_VERSION } else { 'latest' }
    $Root = if ($env:FOAR_INSTALL) { $env:FOAR_INSTALL } else { Join-Path $HOME '.foar' }
    $BinDir = if ($env:FOAR_BIN_DIR) { $env:FOAR_BIN_DIR } else { Join-Path $Root 'bin' }

    $color = -not $env:NO_COLOR -and $Host.UI.SupportsVirtualTerminal
    $e = [char]27
    function Paint($code, $text) { if ($color) { "$e[${code}m$text$e[0m" } else { $text } }
    $Lamp = '38;2;242;179;61'; $Rail = '38;2;132;156;143'
    function Row($label, $value, [switch]$Done) {
        $mark = if ($Done) { '  ' + (Paint '32' ([char]0x2713)) } else { '' }
        Write-Host ('  ' + (Paint '2' $label.PadRight(11)) + $value + $mark)
    }
    function Fail($message, [string[]]$details) {
        Write-Host ('  ' + (Paint '31' ([char]0x2717)) + " $message")
        foreach ($d in $details) { Write-Host ('    ' + (Paint '2' $d)) }
        Write-Host ''
        throw "foar: $message"
    }
    function Tilde($p) { if ($p.StartsWith($HOME)) { '~' + $p.Substring($HOME.Length) } else { $p } }

    Write-Host ''
    Write-Host ('  ' + (Paint $Lamp ([char]0x25CF)) + (Paint $Rail ([string][char]0x2501 * 3)) + '  ' + (Paint '1' 'FOAR') + ' ' + (Paint '2' 'installer'))
    Write-Host ''

    if ($env:FOAR_UNINSTALL -eq '1') {
        $exe = Join-Path $BinDir 'foar.exe'
        if (Test-Path $exe) { Remove-Item $exe -Force; Row 'Binary' (Tilde $exe) }
        Remove-Item (Join-Path $BinDir 'foar.exe.old') -Force -ErrorAction SilentlyContinue
        $userPath = Get-UserPath
        if (($userPath -split ';') -contains $BinDir) {
            Set-UserPath ((($userPath -split ';') | Where-Object { $_ -and $_ -ne $BinDir }) -join ';')
            Row 'PATH' 'removed from your user PATH'
        }
        Write-Host ''
        Write-Host '  foar is uninstalled.'
        Write-Host ''
        return
    }

    # platform
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    switch ($arch) {
        'AMD64' { $target = 'x86_64-pc-windows-msvc'; $archName = 'x64' }
        'ARM64' { $target = 'aarch64-pc-windows-msvc'; $archName = 'arm64' }
        default { Fail "There's no prebuilt foar for Windows on $arch." @("Build it from source: $Repo#build-from-source") }
    }
    Row 'Platform' "Windows $archName"

    # version
    $DefaultTag = 'v0.3.5'
    if ($Version -eq 'latest') {
        $Tag = ''
        # 1. .../releases/latest redirects to .../releases/tag/vX.Y.Z
        try {
            $r = Invoke-WebRequest -Uri "$Base/latest" -Method Head -UseBasicParsing
            $location = ''
            if ($r.BaseResponse.ResponseUri) { $location = [string]$r.BaseResponse.ResponseUri }             # Windows PowerShell 5.1
            elseif ($r.BaseResponse.RequestMessage) { $location = [string]$r.BaseResponse.RequestMessage.RequestUri }  # PowerShell 7
            if ($location -match '/tag/(v[^/]+)$') { $Tag = $Matches[1] }
        } catch {}
        # 2. GitHub Releases API fallback
        if (-not $Tag) {
            try {
                $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/josmanvis/FOAR/releases/latest' -UseBasicParsing
                if ($rel.tag_name) { $Tag = [string]$rel.tag_name }
            } catch {}
        }
        # 3. Embedded release tag fallback
        if (-not $Tag) { $Tag = $DefaultTag }
    } elseif ($Version.StartsWith('v')) { $Tag = $Version } else { $Tag = "v$Version" }
    Row 'Version' $Tag.Substring(1)

    # download + verify
    $asset = "foar-$target.zip"
    $url = "$Base/download/$Tag/$asset"
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("foar-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zip = Join-Path $tmp $asset
        try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing }
        catch { Fail "Download failed: $url" @($_.Exception.Message, "Releases: $Repo/releases") }
        $kb = [math]::Ceiling((Get-Item $zip).Length / 1KB)
        Row 'Download' ("$asset " + (Paint '2' "$kb KB")) -Done

        try { $sum = (Invoke-WebRequest -Uri "$url.sha256" -UseBasicParsing).Content }
        catch { Fail "Couldn't download the checksum for $asset." @("$url.sha256") }
        if ($sum -is [byte[]]) { $sum = [Text.Encoding]::ASCII.GetString($sum) }
        $want = ([string]$sum).Trim().Split(' ')[0].ToLower()
        $got = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
        if ($want -ne $got) { Fail "The download doesn't match its checksum, so it wasn't installed." @("expected $want", "got      $got") }
        Row 'Checksum' ("sha256 " + $got.Substring(0, 12) + [char]0x2026) -Done

        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
        $exe = Join-Path $BinDir 'foar.exe'
        # a running foar.exe (foar upgrade) can be renamed but not overwritten
        if (Test-Path $exe) { Move-Item $exe "$exe.old" -Force }
        Copy-Item (Join-Path $tmp "foar-$target\foar.exe") $exe -Force
        Remove-Item "$exe.old" -Force -ErrorAction SilentlyContinue
        $installed = & $exe --version
        if ($LASTEXITCODE -ne 0) { Fail "The installed foar doesn't run on this machine." @($exe) }
        Row 'Installed' (Tilde $exe) -Done
    } finally {
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }

    # PATH: for new terminals (user PATH) and for this one
    $userPath = Get-UserPath
    if (($userPath -split ';') -notcontains $BinDir) {
        Set-UserPath ((@($BinDir) + ($userPath -split ';' | Where-Object { $_ })) -join ';')
        Row 'On PATH' 'added to your user PATH' -Done
    } else {
        Row 'On PATH' (Tilde $BinDir) -Done
    }
    if (($env:Path -split ';') -notcontains $BinDir) { $env:Path = "$BinDir;$env:Path" }

    Write-Host ''
    Write-Host ('  ' + (Paint '32' $installed) + ' is ready.')
    Write-Host ''
    Write-Host '  Start a project:'
    Write-Host ''
    foreach ($c in 'foar init my-app', 'cd my-app', 'foar dev') { Write-Host ('    ' + (Paint '36' $c)) }
    Write-Host ''
    Write-Host ('  ' + (Paint '2' 'Guide ') + '   https://josmanvis.github.io/FOAR/docs/guide.html')
    Write-Host ('  ' + (Paint '2' 'Update') + '   foar upgrade')
    Write-Host ''
}

Install-Foar
