$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$statePath = Join-Path $root 'questions-data.json'
if (Test-Path -LiteralPath $statePath) {
    Write-Host 'This folder already has bot data. Unpack a fresh archive for a different bot.'
    exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js was not found. Install Node.js 18 or newer, then run setup.cmd again.'
    exit 1
}

Write-Host 'Setting up Dima bot. The token will stay in a file on this computer.'
$secret = Read-Host 'Paste the new bot token from BotFather' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
if ($token -notmatch '^\d+:[A-Za-z0-9_-]{20,}$') {
    Write-Host 'The token does not look valid. Check the message from BotFather.'
    exit 1
}

$channel = (Read-Host 'New public channel username (for example, @podmasku)').Trim()
if ($channel -notmatch '^@[A-Za-z0-9_]{5,32}$') {
    Write-Host 'Enter a public channel username in the form @username.'
    exit 1
}

$config = @{ token = $token; adminId = 1134776602; channelId = $channel } | ConvertTo-Json
$configPath = Join-Path $root 'bot-config.json'
[System.IO.File]::WriteAllText($configPath, $config, (New-Object System.Text.UTF8Encoding($false)))
$token = $null
Write-Host 'Done. Dima is the moderator. Now run start-bot.cmd.'
