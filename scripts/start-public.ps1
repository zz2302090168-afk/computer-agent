$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

function Test-LocalSite {
    try {
        $response = Invoke-WebRequest 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch { return $false }
}

try {
    $tunnelExe = Join-Path $projectRoot 'tmp\cloudflared.exe'
    if (-not (Test-Path -LiteralPath $tunnelExe)) {
        throw '缺少 tmp\cloudflared.exe，请先将 cloudflared 放到该位置。'
    }
    if (-not (Test-LocalSite)) {
        $listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
        if ($listener) { throw '3000 端口已有程序占用，但首页访问失败，请检查现有服务。' }
        $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
        if (-not (Test-Path '.next\BUILD_ID')) {
            Write-Host '首次启动：正在构建项目……'
            & pnpm.cmd build
            if ($LASTEXITCODE -ne 0) { throw '项目构建失败。' }
        }
        New-Item -ItemType Directory -Force 'logs\launcher' | Out-Null
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $server = Start-Process -FilePath $nodeExe -ArgumentList 'node_modules/next/dist/bin/next','start','-p','3000' -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput "logs\launcher\server-$stamp.log" -RedirectStandardError "logs\launcher\server-$stamp.error.log"
        Write-Host '正在启动本地服务……'
        $ready = $false
        for ($i = 0; $i -lt 60; $i++) {
            if (Test-LocalSite) { $ready = $true; break }
            if ($server.HasExited) { throw '服务启动失败，请查看 logs\launcher 中的日志。' }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw '等待本地服务超时，请查看 logs\launcher 中的日志。' }
    }
    Write-Host '本地服务：http://localhost:3000' -ForegroundColor Green

    # 仅复用本启动器使用的固定管理端口，避免重复创建隧道。
    $existingTunnel = $null
    try {
        $health = Invoke-WebRequest 'http://127.0.0.1:20241/ready' -UseBasicParsing -TimeoutSec 2
        $info = Invoke-RestMethod 'http://127.0.0.1:20241/quicktunnel' -TimeoutSec 2
        if ($health.StatusCode -eq 200 -and $info.hostname -match '^[a-z0-9-]+\.trycloudflare\.com$') {
            $existingTunnel = 'https://' + $info.hostname
        }
    } catch {}
    if ($existingTunnel) {
        Write-Host "已有公网网址：$existingTunnel" -ForegroundColor Green
        Write-Host '已复用现有隧道；仍需保持原隧道运行。'
        Read-Host '按 Enter 关闭本提示窗口' | Out-Null
        exit 0
    }
    Write-Host '正在生成公网网址，请等待出现 https://…trycloudflare.com。'
    Write-Host '请保持本窗口打开；电脑关机、休眠或断网后无法访问。'
    New-Item -ItemType Directory -Force 'logs\launcher' | Out-Null
    $tunnelLog = Join-Path $projectRoot ('logs\launcher\tunnel-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    Write-Host "详细日志：$tunnelLog"
    $publicUrl = $null
    $connected = $false
    $previousPreference = $ErrorActionPreference
    try {
        # 正常隧道日志也写入 stderr，不能将其视为启动失败。
        $ErrorActionPreference = 'Continue'
        & $tunnelExe tunnel --url http://localhost:3000 --metrics 127.0.0.1:20241 --no-autoupdate 2>&1 | ForEach-Object {
            $line = $_.ToString()
            Add-Content -LiteralPath $tunnelLog -Value $line -Encoding UTF8 -ErrorAction Stop
            if (-not $publicUrl -and $line -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
                $publicUrl = $Matches[0]
                Write-Host "已分配网址（正在连接）：$publicUrl" -ForegroundColor Yellow
            }
            if (-not $connected -and $line -match 'Registered tunnel connection') {
                $connected = $true
                Write-Host ''
                Write-Host '隧道已连接，复制下方网址分享：' -ForegroundColor Green
                Write-Host $publicUrl -ForegroundColor Cyan
                Write-Host '请保持本窗口打开。'
            }
            if ($line -match '\b(ERR|FTL)\b') {
                Write-Host "隧道异常：$line" -ForegroundColor Red
            }
        }
        $tunnelExitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($tunnelExitCode -ne 0) { throw "隧道退出或启动失败，请查看日志：$tunnelLog" }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
