$ErrorActionPreference = 'Stop'

# The Vite development server serves transformed JavaScript with HTTP no-cache
# headers. A corrupted WebView2 disk-cache entry can nevertheless be restored as
# the top-level document, making the app display raw HTTP headers and JavaScript.
# Clear only disposable caches before a fresh desktop-development session.
if (Get-Process -Name 'coopagent' -ErrorAction SilentlyContinue) {
    exit 0
}

$profileRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'com.coopagent.desktop\EBWebView'))
if (-not (Test-Path -LiteralPath $profileRoot -PathType Container)) {
    exit 0
}

$cachePaths = @(
    (Join-Path $profileRoot 'Default\Cache'),
    (Join-Path $profileRoot 'Default\Code Cache'),
    (Join-Path $profileRoot 'Default\GPUCache'),
    (Join-Path $profileRoot 'GPUPersistentCache'),
    (Join-Path $profileRoot 'GrShaderCache'),
    (Join-Path $profileRoot 'ShaderCache')
)
$profilePrefix = $profileRoot.TrimEnd('\') + '\'

foreach ($cachePath in $cachePaths) {
    $resolvedCache = [IO.Path]::GetFullPath($cachePath)
    if (-not $resolvedCache.StartsWith($profilePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clear a cache outside the CoopAgent WebView2 profile: $resolvedCache"
    }
    if (Test-Path -LiteralPath $resolvedCache) {
        Remove-Item -LiteralPath $resolvedCache -Recurse -Force
    }
}
