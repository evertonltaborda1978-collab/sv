# parar_de_versionar_supabase_temp.ps1
# Tira a pasta supabase\.temp do controle do Git (os arquivos continuam no seu computador)
# e acrescenta a pasta ao .gitignore. NAO faz commit: o commit e feito no GitHub Desktop.
# Rode na pasta principal do projeto (trabalhoeverton), nunca dentro de \android.

Set-Location $PSScriptRoot

if ((Get-Location).Path -like "*\android") {
    Write-Host "ATENCAO: voce esta dentro da pasta android. Salve este arquivo na pasta principal (trabalhoeverton)." -ForegroundColor Yellow
    exit
}

Write-Host ""
Write-Host "=== Tirando supabase/.temp do controle do Git ===" -ForegroundColor Cyan
git rm -r --cached supabase/.temp

$gi = ".gitignore"
if (-not (Test-Path $gi)) {
    New-Item -ItemType File $gi | Out-Null
}
$linhas = Get-Content $gi -ErrorAction SilentlyContinue
if ($linhas -notcontains "supabase/.temp/") {
    Add-Content $gi "`nsupabase/.temp/"
    Write-Host "Linha 'supabase/.temp/' acrescentada ao .gitignore." -ForegroundColor Green
} else {
    Write-Host "O .gitignore ja tinha a linha 'supabase/.temp/'." -ForegroundColor Green
}

Write-Host ""
Write-Host "=== Estado atual (git status) ===" -ForegroundColor Cyan
git status --short

Write-Host ""
Write-Host "Pronto. Agora abra o GitHub Desktop, faca o commit com o resumo 'Parar de versionar supabase/.temp' e toque em Push origin." -ForegroundColor Cyan
