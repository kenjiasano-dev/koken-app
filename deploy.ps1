<#
  カーコン工賃管理アプリ デプロイスクリプト
  使い方: powershell -File deploy.ps1 -Message "変更内容の説明"
  前提: index.html はこのリポジトリ(クローン)内で編集済みであること
        環境変数 GITHUB_TOKEN_KOKEN が設定済みであること
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$Message
)

$ErrorActionPreference = "Stop"
$repoPath = $PSScriptRoot
Set-Location $repoPath

if (-not $env:GITHUB_TOKEN_KOKEN) {
    Write-Error "環境変数 GITHUB_TOKEN_KOKEN が設定されていません。デプロイを中止しました。"
    exit 1
}

# 1. リモートとの乖離チェック(先行して知らずに上書きしないため)
Write-Host "== origin と同期確認 ==" -ForegroundColor Cyan
git fetch origin
$behindCount = (git rev-list --count HEAD..origin/main).Trim()
if ($behindCount -ne "0") {
    Write-Error "origin/main が $behindCount コミット先行しています。先に `git pull` して差分を確認してください。デプロイを中止しました。"
    exit 1
}

# 2. APP_VERSION自動採番(前回コミットから変わっていなければ自動で上げる。手動で上げてあればそれを尊重)
function Step-VersionSuffix([string]$suffix) {
    $chars = $suffix.ToCharArray()
    for ($i = $chars.Length - 1; $i -ge 0; $i--) {
        if ($chars[$i] -ne 'z') {
            $chars[$i] = [char]([int]$chars[$i] + 1)
            return -join $chars
        }
        $chars[$i] = 'a'
    }
    return 'a' + (-join $chars)
}

$html = [System.IO.File]::ReadAllText("$repoPath\index.html")
$currentVersionMatch = [regex]::Match($html, "APP_VERSION\s*=\s*'([^']+)'")
$lastCommittedHtml = git show HEAD:index.html
$lastVersionMatch = [regex]::Match($lastCommittedHtml, "APP_VERSION\s*=\s*'([^']+)'")

if ($currentVersionMatch.Success -and $lastVersionMatch.Success -and ($currentVersionMatch.Groups[1].Value -eq $lastVersionMatch.Groups[1].Value)) {
    Write-Host "== APP_VERSION自動採番 ==" -ForegroundColor Cyan
    $oldVersion = $currentVersionMatch.Groups[1].Value
    $parts = [regex]::Match($oldVersion, '^(\d{8})([a-z]*)$')
    $today = Get-Date -Format "yyyyMMdd"
    if ($parts.Success) {
        $datePart = $parts.Groups[1].Value
        $suffixPart = $parts.Groups[2].Value
        if ($datePart -eq $today) {
            if ($suffixPart -eq "") {
                $newVersion = "$datePart" + "a"
            } else {
                $newVersion = "$datePart" + (Step-VersionSuffix $suffixPart)
            }
        } else {
            $newVersion = "$today" + "a"
        }
        $newHtml = $html -replace "(APP_VERSION\s*=\s*')$([regex]::Escape($oldVersion))(')", "`${1}$newVersion`${2}"
        [System.IO.File]::WriteAllText("$repoPath\index.html", $newHtml, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "APP_VERSION: $oldVersion -> $newVersion" -ForegroundColor Green
        $html = $newHtml
    } else {
        Write-Warning "APP_VERSIONの形式(yyyyMMdd+英字)を認識できませんでした。自動採番をスキップします。手動で確認してください。"
    }
} else {
    Write-Host "APP_VERSIONは手動で更新済みです ($($currentVersionMatch.Groups[1].Value))。自動採番はスキップします。" -ForegroundColor Cyan
}

# 2.5. 自動テスト(tests/run.js)
#      工賃が「送ったつもりで消える」等の再発を、デプロイ前に自動で止める
Write-Host "== 自動テスト ==" -ForegroundColor Cyan
node "$repoPath\tests\run.js"
if ($LASTEXITCODE -ne 0) {
    Write-Error "自動テストに失敗しました。デプロイを中止しました。"
    exit 1
}

# 3. 構文チェック＋重複関数定義チェック
#    対象はHTML全ファイル。以前はindex.htmlしか見ておらず、app.htmlに死んだ二重定義が
#    700行たまっていたのを2026/8/5に発見・削除した。同じ穴を二度と開けないため全ファイルを回す。
$targets = @('index.html', 'app.html', 'board.html') | Where-Object { Test-Path "$repoPath\$_" }

foreach ($target in $targets) {
    Write-Host "== 構文チェック: $target ==" -ForegroundColor Cyan
    $targetHtml = [System.IO.File]::ReadAllText("$repoPath\$target")
    $m = [regex]::Matches($targetHtml, '(?s)<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>')
    $jsBody = ($m | ForEach-Object { $_.Groups[1].Value }) -join "`n"
    $jsPath = "$env:TEMP\koken-deploy-check.js"
    [System.IO.File]::WriteAllText($jsPath, $jsBody, (New-Object System.Text.UTF8Encoding($false)))
    node --check $jsPath
    if ($LASTEXITCODE -ne 0) {
        Write-Error "$target に構文エラーがあります。デプロイを中止しました。"
        exit 1
    }

    # 重複関数定義チェック(旧・末尾追記方式時代に混入した同名関数の再発防止)
    # 桁0の定義だけを数える。字下げされた関数は別の関数の中のローカル関数で、同名でも衝突しない。
    $jsLines = $jsBody -split "`r?`n"
    $funcCounts = @{}
    foreach ($line in $jsLines) {
        if ($line -match '^function\s+([A-Za-z0-9_]+)\s*\(') {
            $name = $Matches[1]
            if ($funcCounts.ContainsKey($name)) { $funcCounts[$name] += 1 } else { $funcCounts[$name] = 1 }
        }
    }
    $dupes = $funcCounts.GetEnumerator() | Where-Object { $_.Value -gt 1 }
    if ($dupes) {
        Write-Host "$target で重複定義された関数:" -ForegroundColor Red
        $dupes | ForEach-Object { Write-Host ("  {0} ({1}回定義)" -f $_.Key, $_.Value) -ForegroundColor Red }
        Write-Error "同名関数が複数回定義されています(後の定義が前を上書きし、直しても画面が変わらない事故のもと)。デプロイを中止しました。"
        exit 1
    }
    Write-Host "  OK ($target)" -ForegroundColor Green
}

# 4. commit & push
#    app.html を含めないと、app.html だけ直したときに「反映されたはずが実は未push」になる(2026/8/4に発生)
Write-Host "== コミット & プッシュ ==" -ForegroundColor Cyan
git add index.html app.html board.html sw.js tests/ deploy.ps1
git commit -m $Message
git push "https://$($env:GITHUB_TOKEN_KOKEN)@github.com/kenjiasano-dev/koken-app.git" main

Write-Host "== デプロイ完了 ==" -ForegroundColor Green
Write-Host "URL: https://kenjiasano-dev.github.io/koken-app/"

# 5. 本番反映の自動確認(GitHub PagesのCDN反映待ち、最大2分)
$finalVersionMatch = [regex]::Match($html, "APP_VERSION\s*=\s*'([^']+)'")
if ($finalVersionMatch.Success) {
    $finalVersion = $finalVersionMatch.Groups[1].Value
    Write-Host "== 本番反映確認 (APP_VERSION: $finalVersion) ==" -ForegroundColor Cyan
    $siteUrl = "https://kenjiasano-dev.github.io/koken-app/"
    $confirmed = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Seconds 6
        try {
            $resp = Invoke-WebRequest -Uri "$siteUrl`?cachebust=$([Guid]::NewGuid().ToString())" -UseBasicParsing -TimeoutSec 10
            if ($resp.Content -match [regex]::Escape("APP_VERSION = '$finalVersion'")) {
                $confirmed = $true
                break
            }
        } catch {}
    }
    if ($confirmed) {
        Write-Host "本番反映を確認しました。" -ForegroundColor Green
    } else {
        Write-Warning "2分以内に本番反映を確認できませんでした。CDN反映待ちの可能性があります。時間を置いて手動で確認してください: $siteUrl"
    }
} else {
    Write-Warning "APP_VERSIONを検出できず、本番反映確認をスキップしました。"
}
