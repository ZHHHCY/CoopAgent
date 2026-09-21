param(
    [Alias('Host')][string]$HostId
)

$ErrorActionPreference = 'Stop'

$applicationGameARoot = Split-Path -Parent $PSScriptRoot
$gameARoot = if ($env:COOPAGENT_WORKSPACE_ROOT) { Join-Path $env:COOPAGENT_WORKSPACE_ROOT 'game-a' } else { $applicationGameARoot }
$coreMod = Join-Path $gameARoot 'core\GameA.SC2Mod'
$coreManifestPath = Join-Path $coreMod 'GameA.Core.json'
$hostRegistryPath = Join-Path $gameARoot 'hosts.json'
$coreManifest = Get-Content -LiteralPath $coreManifestPath -Raw -Encoding utf8 | ConvertFrom-Json
$hostRegistry = Get-Content -LiteralPath $hostRegistryPath -Raw -Encoding utf8 | ConvertFrom-Json

$requiredCoreFiles = @(
    (Join-Path $coreMod 'ComponentList.SC2Components'),
    (Join-Path $coreMod 'DocumentInfo'),
    (Join-Path $coreMod 'DocumentInfo.version'),
    (Join-Path $coreMod 'GameData.version'),
    (Join-Path $coreMod 'GameText.version'),
    (Join-Path $coreMod 'Base.SC2Data\GameData.xml'),
    (Join-Path $PSScriptRoot 'generate-commander-compat.mjs'),
    (Join-Path $gameARoot 'runtime-baseline.json'),
    $coreManifestPath,
    $hostRegistryPath
)
foreach ($requiredFile in $requiredCoreFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "Required Game A file is missing: $requiredFile"
    }
}

foreach ($officialGalaxy in @('LibCOOC.galaxy', 'LibCOOC_h.galaxy', 'LibCOMI.galaxy', 'LibCOUI.galaxy')) {
    $packagedOfficialSource = Join-Path (Join-Path $coreMod 'Base.SC2Data') $officialGalaxy
    if (Test-Path -LiteralPath $packagedOfficialSource) {
        throw "Official co-op Galaxy must be generated into disposable build output, not packaged in Game A core: $packagedOfficialSource"
    }
}

foreach ($xmlFile in @(
    (Join-Path $coreMod 'ComponentList.SC2Components'),
    (Join-Path $coreMod 'DocumentInfo'),
    (Join-Path $coreMod 'Base.SC2Data\GameData.xml')
)) {
    $null = [xml][IO.File]::ReadAllText($xmlFile)
}
Get-ChildItem -LiteralPath (Join-Path $coreMod 'Base.SC2Data\GameData') -Recurse -File -Filter '*.xml' |
    ForEach-Object {
        [xml]$catalogXml = [IO.File]::ReadAllText($_.FullName)
        if ($catalogXml.DocumentElement.Name -ne 'Catalog') {
            throw "Core Catalog file must have a Catalog root: $($_.FullName)"
        }
    }

$declaredGalaxy = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($module in @($coreManifest.galaxy.modules)) {
    $relative = ([string]$module.path).Replace('\', '/')
    if (-not $declaredGalaxy.Add($relative)) {
        throw "Duplicate Galaxy module in GameA.Core.json: $relative"
    }
}
$coreGalaxyRelative = ([string]$coreManifest.galaxy.core).Replace('\', '/')
if (-not $declaredGalaxy.Add($coreGalaxyRelative)) {
    throw "Core Galaxy module is duplicated in GameA.Core.json: $coreGalaxyRelative"
}

$actualGalaxy = Get-ChildItem -LiteralPath (Join-Path $coreMod 'Base.SC2Data') -Recurse -File -Filter '*.galaxy'
foreach ($galaxyFile in $actualGalaxy) {
    $relative = $galaxyFile.FullName.Substring($coreMod.Length).TrimStart('\').Replace('\', '/')
    if (-not $declaredGalaxy.Contains($relative)) {
        throw "Galaxy module is not registered in GameA.Core.json: $relative"
    }
}
foreach ($declaredPath in $declaredGalaxy) {
    $absolute = Join-Path $coreMod $declaredPath.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $absolute -PathType Leaf)) {
        throw "Declared Galaxy module is missing: $declaredPath"
    }
}

$coreGalaxyText = [IO.File]::ReadAllText((Join-Path $coreMod $coreGalaxyRelative.Replace('/', '\')))
if (-not $coreGalaxyText.Contains('GameA_GeneratedInit();')) {
    throw 'Game A core does not call the generated feature initializer.'
}
if (-not $coreGalaxyText.Contains('GameA_GeneratedConfigureCommander();')) {
    throw 'Game A core does not call the generated commander configuration hook.'
}

$hostIds = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$hostOutputs = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($hostConfig in @($hostRegistry.hosts)) {
    if (-not $hostIds.Add([string]$hostConfig.id)) {
        throw "Duplicate host id: $($hostConfig.id)"
    }
    if (-not $hostOutputs.Add([string]$hostConfig.outputName)) {
        throw "Duplicate host output name: $($hostConfig.outputName)"
    }
}
if (-not $hostIds.Contains([string]$hostRegistry.defaultHost)) {
    throw "Default host is not registered: $($hostRegistry.defaultHost)"
}

if ([string]::IsNullOrWhiteSpace($HostId)) {
    $hostsToValidate = @($hostRegistry.hosts)
}
else {
    $hostsToValidate = @($hostRegistry.hosts | Where-Object { $_.id -eq $HostId })
    if ($hostsToValidate.Count -ne 1) {
        throw "Unknown Game A host: $HostId"
    }
}

foreach ($hostConfig in $hostsToValidate) {
    $hostMap = [IO.Path]::GetFullPath((Join-Path $applicationGameARoot ([string]$hostConfig.source)))
    $adapter = Join-Path $hostMap ([string]$hostConfig.adapter)
    foreach ($hostFile in @(
        (Join-Path $hostMap 'ComponentList.SC2Components'),
        (Join-Path $hostMap 'DocumentInfo'),
        (Join-Path $hostMap 'MapScript.galaxy'),
        (Join-Path $hostMap 'Triggers'),
        $adapter
    )) {
        if (-not (Test-Path -LiteralPath $hostFile -PathType Leaf)) {
            throw "Bundled host '$($hostConfig.id)' is missing. Restore the complete repository checkout: $hostFile"
        }
    }

    $mapDocumentInfo = [IO.File]::ReadAllText((Join-Path $hostMap 'DocumentInfo'))
    if ($mapDocumentInfo.Contains('file:Mods\GameA\GameA.SC2Mod')) {
        throw "Host '$($hostConfig.id)' still has a runtime GameA.SC2Mod dependency."
    }

    $adapterInclude = 'include "' + ([IO.Path]::ChangeExtension(([string]$hostConfig.adapter), $null)).Replace('\', '/').TrimEnd('.') + '"'
    $mapScript = [IO.File]::ReadAllText((Join-Path $hostMap 'MapScript.galaxy'))
    if (-not $mapScript.Contains('include "scripts/generated/GameABootstrap"') -or
        -not $mapScript.Contains($adapterInclude) -or
        -not $mapScript.Contains(([string]$hostConfig.entry) + '();')) {
        throw "Host '$($hostConfig.id)' does not implement the MapScript contract."
    }

    $adapterText = [IO.File]::ReadAllText($adapter)
    if (-not $adapterText.Contains('GameA_GeneratedBeforeMissionStart();')) {
        throw "Host '$($hostConfig.id)' does not call the generated before-mission-start hook."
    }
    if (-not $adapterText.Contains('GameA_GeneratedPostMissionStart();')) {
        throw "Host '$($hostConfig.id)' does not call the generated post-mission-start hook."
    }
    if ($adapterText.Contains('GameA_RaynorResearchCostApplyConfiguredPlayers')) {
        throw "Host '$($hostConfig.id)' directly depends on an optional Raynor module."
    }

    $triggerData = [IO.File]::ReadAllText((Join-Path $hostMap 'Triggers'))
    if (-not $triggerData.Contains('include &quot;scripts/generated/GameABootstrap&quot;') -or
        -not $triggerData.Contains('<InitFunc>' + ([string]$hostConfig.entry) + '</InitFunc>')) {
        throw "Host '$($hostConfig.id)' Trigger data would regenerate an outdated entry."
    }

    foreach ($forbiddenRelative in @(
        'scripts\GameA.galaxy',
        'scripts\GameARaynor.galaxy',
        'scripts\GameAIntegration.galaxy',
        'Base.SC2Data\GameData\EffectData.xml'
    )) {
        $forbiddenFile = Join-Path $hostMap $forbiddenRelative
        if (Test-Path -LiteralPath $forbiddenFile) {
            throw "Core content is embedded in host '$($hostConfig.id)': $forbiddenFile"
        }
    }
}

Write-Output 'Game A structure validation passed.'
Write-Output "Core source: $coreMod"
Write-Output "Registered hosts: $($hostIds.Count)"
