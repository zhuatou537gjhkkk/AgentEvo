# kill-port.ps1 — 杀掉占用指定端口的进程（默认 3000）
# 用法: .\kill-port.ps1 [port]

param([int]$Port = 3000)

Write-Host "🔍 查找占用端口 $Port 的进程..." -ForegroundColor Cyan

$conn = netstat -ano | Select-String ":$Port "
if (-not $conn) {
    Write-Host "✅ 端口 $Port 未被占用" -ForegroundColor Green
    exit 0
}

$pids = $conn | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique
foreach ($pid in $pids) {
    Write-Host "⚠️  终止 PID=$pid ..." -ForegroundColor Yellow
    taskkill /PID $pid /F 2>$null
}

Start-Sleep -Seconds 1

$check = netstat -ano | Select-String ":$Port "
if ($check) {
    Write-Host "❌ 端口 $Port 仍被占用，请手动处理" -ForegroundColor Red
} else {
    Write-Host "✅ 端口 $Port 已释放" -ForegroundColor Green
}
