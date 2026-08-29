$source=Join-Path $env:TEMP 'geonames-it\IT.txt'
$rows=foreach($line in [System.IO.File]::ReadLines($source)){ $p=$line -split "`t"; if($p.Count -ge 15 -and $p[6] -eq 'P' -and $p[8] -eq 'IT' -and $p[4] -match '^-?\d+(\.\d+)?$' -and $p[5] -match '^-?\d+(\.\d+)?$'){ [pscustomobject]@{name=$p[1];lat=[double]$p[4];lon=[double]$p[5];admin=$p[10]} } }
$groups=$rows|Group-Object name
$result=foreach($g in $groups){foreach($item in $g.Group){$label=$item.name;if($g.Count -gt 1 -and $item.admin){$label="$($item.name) — $($item.admin)"};[pscustomobject]@{name=$label;lat=$item.lat;lon=$item.lon}}}
$result|Sort-Object name -Unique|ConvertTo-Json -Compress|Set-Content (Join-Path $PSScriptRoot 'cities.json') -Encoding UTF8
Write-Output "localita=$(@($result).Count)"