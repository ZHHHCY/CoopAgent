param(
    [Alias('Host')][string]$HostId,
    [string]$DatabaseFile,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

$applicationGameARoot = Split-Path -Parent $PSScriptRoot
$gameARoot = if ($env:COOPAGENT_WORKSPACE_ROOT) { Join-Path $env:COOPAGENT_WORKSPACE_ROOT 'game-a' } else { $applicationGameARoot }
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $gameARoot))
$applicationRoot = Split-Path -Parent $applicationGameARoot
$transactionBridge = Join-Path $applicationRoot 'scripts\game-a-transaction.mjs'
# Normal builds acquire the same OS-backed lock as PatchPlan applications.
# Isolated validation sandboxes do not contain the repository bridge.
if ((Test-Path -LiteralPath $transactionBridge) -and $env:COOPAGENT_GAME_A_BUILD_LOCK -ne $projectRoot) {
    $nodeExecutable = Join-Path $applicationRoot '.tools\node\node.exe'
    if (-not (Test-Path -LiteralPath $nodeExecutable)) { $nodeExecutable = 'node' }
    $bridgeArguments = @($transactionBridge, 'build')
    if (-not [string]::IsNullOrWhiteSpace($HostId)) { $bridgeArguments += @('-HostId', $HostId) }
    if (-not [string]::IsNullOrWhiteSpace($DatabaseFile)) { $bridgeArguments += @('-DatabaseFile', $DatabaseFile) }
    if ($Check) { $bridgeArguments += '-Check' }
    & $nodeExecutable @bridgeArguments
    if ($LASTEXITCODE -ne 0) { throw 'Map Runtime build was blocked or failed; see the diagnostic above.' }
    return
}
$coreMod = Join-Path $gameARoot 'core\GameA.SC2Mod'
$coreManifestPath = Join-Path $coreMod 'GameA.Core.json'
$hostRegistryPath = Join-Path $gameARoot 'hosts.json'
$buildRoot = [IO.Path]::GetFullPath((Join-Path $gameARoot 'build'))

$hostRegistry = Get-Content -LiteralPath $hostRegistryPath -Raw -Encoding utf8 | ConvertFrom-Json
$coreManifest = Get-Content -LiteralPath $coreManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($HostId)) {
    $HostId = [string]$hostRegistry.defaultHost
}

$matchingHosts = @($hostRegistry.hosts | Where-Object { $_.id -eq $HostId })
if ($matchingHosts.Count -ne 1) {
    $availableHosts = (($hostRegistry.hosts | ForEach-Object { $_.id }) -join ', ')
    throw "Unknown Map Runtime host '$HostId'. Available hosts: $availableHosts"
}
$hostConfig = $matchingHosts[0]

$hostMap = [IO.Path]::GetFullPath((Join-Path $applicationGameARoot ([string]$hostConfig.source)))
$outputName = [string]$hostConfig.outputName
if ([IO.Path]::GetFileName($outputName) -ne $outputName -or -not $outputName.EndsWith('.SC2Map')) {
    throw "Invalid host output name: $outputName"
}

foreach ($requiredSource in @($coreMod, $hostMap, $coreManifestPath, $hostRegistryPath)) {
    if (-not (Test-Path -LiteralPath $requiredSource)) {
        if ($requiredSource -eq $hostMap) {
            throw "Bundled Map Runtime host is missing. Restore the complete repository checkout: $requiredSource"
        }
        throw "Map Runtime source is missing: $requiredSource"
    }
}

$runtimeBaselinePath = Join-Path $gameARoot 'runtime-baseline.json'
$commanderCompatGenerator = Join-Path $PSScriptRoot 'generate-commander-compat.mjs'
foreach ($compatibilitySource in @($runtimeBaselinePath, $commanderCompatGenerator)) {
    if (-not (Test-Path -LiteralPath $compatibilitySource -PathType Leaf)) {
        throw "Map Runtime commander compatibility source is missing: $compatibilitySource"
    }
}
$compatNodeExecutable = Join-Path $applicationRoot '.tools\node\node.exe'
if (-not (Test-Path -LiteralPath $compatNodeExecutable -PathType Leaf)) { $compatNodeExecutable = 'node' }
$compatibilityArguments = @('--no-warnings', $commanderCompatGenerator, 'fingerprint', '--baseline', $runtimeBaselinePath)
if (-not [string]::IsNullOrWhiteSpace($DatabaseFile)) {
    $compatibilityArguments += @('--database', ([IO.Path]::GetFullPath($DatabaseFile)))
}
$compatibilityOutput = @(& $compatNodeExecutable @compatibilityArguments)
if ($LASTEXITCODE -ne 0) { throw 'Unable to verify the local co-op scripts used by Map Runtime.' }
$compatibilityFingerprint = ([string]$compatibilityOutput[-1]).Trim()
if ($compatibilityFingerprint -notmatch '^[a-f0-9]{64}$') {
    throw "Invalid Map Runtime commander compatibility fingerprint: $compatibilityFingerprint"
}

function Get-FileSha256 {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    $stream = [IO.File]::OpenRead($LiteralPath)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Get-GameASourceHash {
    $manifestLines = @("host=$HostId")
    foreach ($sourceRoot in @($coreMod, $hostMap)) {
        $resolvedRoot = (Resolve-Path -LiteralPath $sourceRoot).Path
        $manifestLines += Get-ChildItem -LiteralPath $resolvedRoot -Recurse -File |
            Sort-Object FullName |
            ForEach-Object {
                $relative = $_.FullName.Substring($resolvedRoot.Length).TrimStart('\')
                $hash = Get-FileSha256 -LiteralPath $_.FullName
                "$resolvedRoot|$relative|$hash"
            }
    }
    $manifestLines += "registry|$(Get-FileSha256 -LiteralPath $hostRegistryPath)"
    $manifestLines += "builder|$(Get-FileSha256 -LiteralPath $PSCommandPath)"
    $manifestLines += "runtime-baseline|$(Get-FileSha256 -LiteralPath $runtimeBaselinePath)"
    $manifestLines += "commander-compat-generator|$(Get-FileSha256 -LiteralPath $commanderCompatGenerator)"
    $manifestLines += "commander-compat-input|$compatibilityFingerprint"

    $bytes = [Text.Encoding]::UTF8.GetBytes(($manifestLines -join "`n"))
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace('-', '')
    }
    finally {
        $sha256.Dispose()
    }
}

function Get-CorePath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    [IO.Path]::GetFullPath((Join-Path $coreMod ($RelativePath.Replace('/', '\'))))
}

function Get-GeneratedGalaxyPath {
    param([Parameter(Mandatory = $true)][string]$CoreGalaxyPath)

    $baseData = [IO.Path]::GetFullPath((Join-Path $coreMod 'Base.SC2Data'))
    $source = Get-CorePath $CoreGalaxyPath
    if (-not $source.StartsWith($baseData + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Galaxy module must be under Base.SC2Data: $CoreGalaxyPath"
    }
    $source.Substring($baseData.Length).TrimStart('\')
}

function Merge-Catalog {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    [xml]$sourceXml = [IO.File]::ReadAllText($Source)
    if ($sourceXml.DocumentElement.Name -ne 'Catalog') {
        throw "Core Catalog file must have a Catalog root: $Source"
    }

    $destinationDirectory = [IO.Path]::GetDirectoryName($Destination)
    New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    if (-not (Test-Path -LiteralPath $Destination)) {
        Copy-Item -LiteralPath $Source -Destination $Destination -Force
        return
    }

    [xml]$destinationXml = [IO.File]::ReadAllText($Destination)
    if ($destinationXml.DocumentElement.Name -ne 'Catalog') {
        throw "Host Catalog file must have a Catalog root: $Destination"
    }
    foreach ($node in $sourceXml.Catalog.ChildNodes) {
        if ($node.NodeType -eq [Xml.XmlNodeType]::Element) {
            $imported = $destinationXml.ImportNode($node, $true)
            $null = $destinationXml.Catalog.AppendChild($imported)
        }
    }

    $settings = New-Object Xml.XmlWriterSettings
    $settings.Encoding = New-Object Text.UTF8Encoding($false)
    $settings.Indent = $true
    $writer = [Xml.XmlWriter]::Create($Destination, $settings)
    try {
        $destinationXml.Save($writer)
    }
    finally {
        $writer.Dispose()
    }
}

function Merge-LocalizedText {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $sourceLines = [IO.File]::ReadAllLines($Source)
    $coreKeys = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($line in $sourceLines) {
        $separator = $line.IndexOf('=')
        if ($separator -gt 0) {
            $null = $coreKeys.Add($line.Substring(0, $separator))
        }
    }

    $result = New-Object 'Collections.Generic.List[string]'
    if (Test-Path -LiteralPath $Destination) {
        foreach ($line in [IO.File]::ReadAllLines($Destination)) {
            $separator = $line.IndexOf('=')
            if ($separator -gt 0 -and $coreKeys.Contains($line.Substring(0, $separator))) {
                continue
            }
            $result.Add($line)
        }
    }
    foreach ($line in $sourceLines) {
        $result.Add($line)
    }

    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Destination)) -Force | Out-Null
    [IO.File]::WriteAllLines($Destination, $result, (New-Object Text.UTF8Encoding($false)))
}

function Write-LatestBuildPointer {
    param(
        [Parameter(Mandatory = $true)][string]$PointerPath,
        [Parameter(Mandatory = $true)][string]$OutputMap,
        [Parameter(Mandatory = $true)][string]$SourceHash
    )

    $relativeOutput = $OutputMap.Substring($buildRoot.Length).TrimStart('\').Replace('\', '/')
    $pointer = [ordered]@{
        schemaVersion = 1
        hostId = $HostId
        sourceHash = $SourceHash.ToLowerInvariant()
        output = $relativeOutput
    }
    $pointerJson = ($pointer | ConvertTo-Json -Depth 4) + "`n"
    $pointerTemp = $PointerPath + '.tmp-' + $PID + '-' + [guid]::NewGuid().ToString('N')
    $pointerBackup = $PointerPath + '.backup-' + $PID + '-' + [guid]::NewGuid().ToString('N')
    try {
        [IO.File]::WriteAllText($pointerTemp, $pointerJson, (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $PointerPath -PathType Leaf) {
            [IO.File]::Replace($pointerTemp, $PointerPath, $pointerBackup)
        }
        else {
            Move-Item -LiteralPath $pointerTemp -Destination $PointerPath
        }
    }
    finally {
        if (Test-Path -LiteralPath $pointerTemp) {
            Remove-Item -LiteralPath $pointerTemp -Force
        }
        if (Test-Path -LiteralPath $pointerBackup) {
            Remove-Item -LiteralPath $pointerBackup -Force
        }
    }
}

$sourceHash = Get-GameASourceHash
$outputStem = [IO.Path]::GetFileNameWithoutExtension($outputName)
$shortHash = $sourceHash.Substring(0, 12).ToLowerInvariant()
$versionsRoot = [IO.Path]::GetFullPath((Join-Path $buildRoot (Join-Path 'versions' $HostId)))
$latestRoot = [IO.Path]::GetFullPath((Join-Path $buildRoot 'latest'))
$latestPointer = [IO.Path]::GetFullPath((Join-Path $latestRoot ($HostId + '.json')))

if ($Check) {
    $outputMap = [IO.Path]::GetFullPath((Join-Path $buildRoot ('.' + $outputName + '.check')))
    $stagingMap = $outputMap
}
else {
    $versionedOutputName = $outputStem + '-' + $shortHash + '.SC2Map'
    $outputMap = [IO.Path]::GetFullPath((Join-Path $versionsRoot $versionedOutputName))
    $stagingMap = [IO.Path]::GetFullPath((Join-Path $versionsRoot ('.' + $versionedOutputName + '.staging')))
}

$stampFile = Join-Path $outputMap '.gamea-build-hash'
$stagingStampFile = Join-Path $stagingMap '.gamea-build-hash'
$buildRootPrefix = $buildRoot.TrimEnd('\') + '\'
foreach ($generatedPath in @($versionsRoot, $latestRoot, $latestPointer, $outputMap, $stagingMap)) {
    if (-not $generatedPath.StartsWith($buildRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to build outside the Map Runtime build directory: $generatedPath"
    }
}

New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
if (-not $Check) {
    New-Item -ItemType Directory -Path $versionsRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $latestRoot -Force | Out-Null
}

$requiredOutput = Join-Path $outputMap 'ComponentList.SC2Components'
if (-not $Check -and
    (Test-Path -LiteralPath $stampFile) -and
    (Test-Path -LiteralPath $requiredOutput) -and
    ([IO.File]::ReadAllText($stampFile).Trim() -eq $sourceHash)) {
    Write-LatestBuildPointer -PointerPath $latestPointer -OutputMap $outputMap -SourceHash $sourceHash
    Write-Output $requiredOutput
    exit 0
}

if (-not $Check -and (Test-Path -LiteralPath $outputMap)) {
    throw "The content-addressed Map Runtime output exists but failed validation: $outputMap"
}

if (Test-Path -LiteralPath $stagingMap) {
    Remove-Item -LiteralPath $stagingMap -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingMap -Force | Out-Null
Get-ChildItem -LiteralPath $hostMap -Force |
    Copy-Item -Destination $stagingMap -Recurse -Force

# Derive the narrow official-script compatibility layer from the user's local
# B97579 database. The repository never carries Blizzard's extracted scripts.
$generateCompatibilityArguments = @('--no-warnings', $commanderCompatGenerator, 'generate', '--baseline', $runtimeBaselinePath, '--output', $stagingMap)
if (-not [string]::IsNullOrWhiteSpace($DatabaseFile)) {
    $generateCompatibilityArguments += @('--database', ([IO.Path]::GetFullPath($DatabaseFile)))
}
$generatedCompatibilityOutput = @(& $compatNodeExecutable @generateCompatibilityArguments)
if ($LASTEXITCODE -ne 0) { throw 'Unable to generate the Map Runtime commander compatibility layer.' }
$generatedCompatibilityFingerprint = ([string]$generatedCompatibilityOutput[-1]).Trim()
if ($generatedCompatibilityFingerprint -ne $compatibilityFingerprint) {
    throw 'The local co-op scripts changed while Map Runtime was being built.'
}

# Galaxy modules are declared in the core manifest so include order and init calls
# are deterministic. The builder, not the host map, discovers their file names.
$declaredModules = @($coreManifest.galaxy.modules | Sort-Object order, path)
$coreModulePath = [string]$coreManifest.galaxy.core
$declaredPaths = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($module in $declaredModules) {
    $null = $declaredPaths.Add(([string]$module.path).Replace('\', '/'))
}
$null = $declaredPaths.Add($coreModulePath.Replace('\', '/'))

$actualGalaxyFiles = Get-ChildItem -LiteralPath (Join-Path $coreMod 'Base.SC2Data') -Recurse -File -Filter '*.galaxy'
foreach ($actualFile in $actualGalaxyFiles) {
    $relative = $actualFile.FullName.Substring($coreMod.Length).TrimStart('\').Replace('\', '/')
    if (-not $declaredPaths.Contains($relative)) {
        throw "Galaxy module is not registered in GameA.Core.json: $relative"
    }
}

$generatedScripts = Join-Path $stagingMap 'scripts\generated'
New-Item -ItemType Directory -Path $generatedScripts -Force | Out-Null
$bootstrapLines = New-Object 'Collections.Generic.List[string]'
$bootstrapLines.Add('// Generated by build-game-a.ps1. Do not edit.')
$initCalls = New-Object 'Collections.Generic.List[string]'
$configureCalls = New-Object 'Collections.Generic.List[string]'
$beforeMissionStartCalls = New-Object 'Collections.Generic.List[string]'
$postMissionStartCalls = New-Object 'Collections.Generic.List[string]'

foreach ($module in $declaredModules) {
    $relativeGalaxy = Get-GeneratedGalaxyPath ([string]$module.path)
    $sourceGalaxy = Get-CorePath ([string]$module.path)
    if (-not (Test-Path -LiteralPath $sourceGalaxy -PathType Leaf)) {
        throw "Declared Galaxy module is missing: $sourceGalaxy"
    }
    $destinationGalaxy = Join-Path $generatedScripts $relativeGalaxy
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destinationGalaxy)) -Force | Out-Null
    Copy-Item -LiteralPath $sourceGalaxy -Destination $destinationGalaxy -Force
    $includeRelative = $relativeGalaxy.Substring(0, $relativeGalaxy.Length - '.galaxy'.Length)
    $includePath = ('scripts/generated/' + $includeRelative.Replace('\', '/'))
    $bootstrapLines.Add("include `"$includePath`"")
    if (-not [string]::IsNullOrWhiteSpace([string]$module.init)) {
        $initCalls.Add(([string]$module.init) + '();')
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$module.configure)) {
        $configureCalls.Add(([string]$module.configure) + '();')
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$module.beforeMissionStart)) {
        $beforeMissionStartCalls.Add(([string]$module.beforeMissionStart) + '();')
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$module.postMissionStart)) {
        $postMissionStartCalls.Add(([string]$module.postMissionStart) + '();')
    }
}

$generatedInit = Join-Path $generatedScripts 'GameAGeneratedInit.galaxy'
$generatedInitLines = New-Object 'Collections.Generic.List[string]'
$generatedInitLines.Add('// Generated by build-game-a.ps1. Do not edit.')
$generatedInitLines.Add('void GameA_GeneratedInit () {')
foreach ($initCall in $initCalls) {
    $generatedInitLines.Add('    ' + $initCall)
}
$generatedInitLines.Add('}')
[IO.File]::WriteAllLines($generatedInit, $generatedInitLines, (New-Object Text.UTF8Encoding($false)))
$bootstrapLines.Add('include "scripts/generated/GameAGeneratedInit"')

$generatedConfigure = Join-Path $generatedScripts 'GameAGeneratedConfigureCommander.galaxy'
$generatedConfigureLines = New-Object 'Collections.Generic.List[string]'
$generatedConfigureLines.Add('// Generated by build-game-a.ps1. Do not edit.')
$generatedConfigureLines.Add('void GameA_GeneratedConfigureCommander () {')
foreach ($configureCall in $configureCalls) {
    $generatedConfigureLines.Add('    ' + $configureCall)
}
$generatedConfigureLines.Add('}')
[IO.File]::WriteAllLines($generatedConfigure, $generatedConfigureLines, (New-Object Text.UTF8Encoding($false)))
$bootstrapLines.Add('include "scripts/generated/GameAGeneratedConfigureCommander"')

$generatedBeforeMissionStart = Join-Path $generatedScripts 'GameAGeneratedBeforeMissionStart.galaxy'
$generatedBeforeMissionStartLines = New-Object 'Collections.Generic.List[string]'
$generatedBeforeMissionStartLines.Add('// Generated by build-game-a.ps1. Do not edit.')
$generatedBeforeMissionStartLines.Add('void GameA_GeneratedBeforeMissionStart () {')
foreach ($beforeMissionStartCall in $beforeMissionStartCalls) {
    $generatedBeforeMissionStartLines.Add('    ' + $beforeMissionStartCall)
}
$generatedBeforeMissionStartLines.Add('}')
[IO.File]::WriteAllLines($generatedBeforeMissionStart, $generatedBeforeMissionStartLines, (New-Object Text.UTF8Encoding($false)))
$bootstrapLines.Add('include "scripts/generated/GameAGeneratedBeforeMissionStart"')

$generatedPostMissionStart = Join-Path $generatedScripts 'GameAGeneratedPostMissionStart.galaxy'
$generatedPostMissionStartLines = New-Object 'Collections.Generic.List[string]'
$generatedPostMissionStartLines.Add('// Generated by build-game-a.ps1. Do not edit.')
$generatedPostMissionStartLines.Add('void GameA_GeneratedPostMissionStart () {')
foreach ($postMissionStartCall in $postMissionStartCalls) {
    $generatedPostMissionStartLines.Add('    ' + $postMissionStartCall)
}
$generatedPostMissionStartLines.Add('}')
[IO.File]::WriteAllLines($generatedPostMissionStart, $generatedPostMissionStartLines, (New-Object Text.UTF8Encoding($false)))
$bootstrapLines.Add('include "scripts/generated/GameAGeneratedPostMissionStart"')

$relativeCoreGalaxy = Get-GeneratedGalaxyPath $coreModulePath
$sourceCoreGalaxy = Get-CorePath $coreModulePath
$destinationCoreGalaxy = Join-Path $generatedScripts $relativeCoreGalaxy
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destinationCoreGalaxy)) -Force | Out-Null
Copy-Item -LiteralPath $sourceCoreGalaxy -Destination $destinationCoreGalaxy -Force
$coreIncludeRelative = $relativeCoreGalaxy.Substring(0, $relativeCoreGalaxy.Length - '.galaxy'.Length)
$coreIncludePath = ('scripts/generated/' + $coreIncludeRelative.Replace('\', '/'))
$bootstrapLines.Add("include `"$coreIncludePath`"")
[IO.File]::WriteAllLines((Join-Path $generatedScripts 'GameABootstrap.galaxy'), $bootstrapLines, (New-Object Text.UTF8Encoding($false)))

# Merge every Catalog file supplied by the core, including future Unit, Weapon,
# Behavior, Upgrade, Actor, Requirement, or other Catalog types.
$coreCatalogRoot = Join-Path $coreMod 'Base.SC2Data\GameData'
$outputCatalogRoot = Join-Path $stagingMap 'Base.SC2Data\GameData'
Get-ChildItem -LiteralPath $coreCatalogRoot -Recurse -File -Filter '*.xml' | ForEach-Object {
    $relative = $_.FullName.Substring($coreCatalogRoot.Length).TrimStart('\')
    Merge-Catalog -Source $_.FullName -Destination (Join-Path $outputCatalogRoot $relative)
}

# Merge every localized text file and let core keys override host keys.
Get-ChildItem -LiteralPath $coreMod -Recurse -File -Filter '*.txt' |
    Where-Object { $_.FullName -match '\\[^\\]+\.SC2Data\\LocalizedData\\' } |
    ForEach-Object {
        $relative = $_.FullName.Substring($coreMod.Length).TrimStart('\')
        Merge-LocalizedText -Source $_.FullName -Destination (Join-Path $stagingMap $relative)
    }

# Copy optional asset roots declared by the core manifest.
foreach ($copyRoot in @($coreManifest.copyRoots)) {
    $relativeRoot = ([string]$copyRoot).Replace('/', '\').Trim('\')
    if ([string]::IsNullOrWhiteSpace($relativeRoot)) {
        throw 'Core copyRoots cannot contain an empty path.'
    }
    $sourceRoot = [IO.Path]::GetFullPath((Join-Path $coreMod $relativeRoot))
    if (-not $sourceRoot.StartsWith(([IO.Path]::GetFullPath($coreMod) + '\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "Core copy root escapes the core directory: $relativeRoot"
    }
    if (Test-Path -LiteralPath $sourceRoot -PathType Container) {
        $destinationParent = [IO.Path]::GetDirectoryName((Join-Path $stagingMap $relativeRoot))
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
        Copy-Item -LiteralPath $sourceRoot -Destination $destinationParent -Recurse -Force
    }
}

[IO.File]::WriteAllText($stagingStampFile, $sourceHash, (New-Object Text.UTF8Encoding($false)))

$requiredStagingFiles = @(
    (Join-Path $stagingMap 'ComponentList.SC2Components'),
    (Join-Path $stagingMap 'MapScript.galaxy'),
    (Join-Path $stagingMap 'scripts\generated\GameABootstrap.galaxy'),
    (Join-Path $stagingMap 'scripts\generated\GameAGeneratedInit.galaxy'),
    (Join-Path $stagingMap 'scripts\generated\GameAGeneratedBeforeMissionStart.galaxy'),
    (Join-Path $stagingMap 'scripts\generated\GameAGeneratedPostMissionStart.galaxy'),
    (Join-Path $stagingMap '.gamea-commander-compat.json'),
    (Join-Path $stagingMap 'Base.SC2Data\LibCOOC.galaxy'),
    (Join-Path $stagingMap 'Base.SC2Data\LibCOOC_h.galaxy'),
    (Join-Path $stagingMap 'Base.SC2Data\LibCOMI.galaxy'),
    (Join-Path $stagingMap 'Base.SC2Data\LibCOUI.galaxy'),
    (Join-Path $stagingMap ([string]$hostConfig.adapter))
)
foreach ($requiredStagingFile in $requiredStagingFiles) {
    if (-not (Test-Path -LiteralPath $requiredStagingFile -PathType Leaf)) {
        throw "Generated Map Runtime file is missing: $requiredStagingFile"
    }
}

$mapScriptText = [IO.File]::ReadAllText((Join-Path $stagingMap 'MapScript.galaxy'))
if (-not $mapScriptText.Contains('include "scripts/generated/GameABootstrap"') -or
    -not $mapScriptText.Contains(([string]$hostConfig.entry) + '();')) {
    throw "Host '$HostId' does not implement the Map Runtime bootstrap contract."
}

Get-ChildItem -LiteralPath $outputCatalogRoot -Recurse -File -Filter '*.xml' | ForEach-Object {
    $null = [xml][IO.File]::ReadAllText($_.FullName)
}

if ($Check) {
    Write-Output (Join-Path $stagingMap 'ComponentList.SC2Components')
    exit 0
}

Move-Item -LiteralPath $stagingMap -Destination $outputMap
Write-LatestBuildPointer -PointerPath $latestPointer -OutputMap $outputMap -SourceHash $sourceHash
Write-Output $requiredOutput
