Remove-Item -Force -ErrorAction SilentlyContinue "$PSScriptRoot\.git\HEAD.lock"
Remove-Item -Force -ErrorAction SilentlyContinue "$PSScriptRoot\.git\index.lock"
Remove-Item -Force -ErrorAction SilentlyContinue "$PSScriptRoot\.git\objects\maintenance.lock"
Set-Location $PSScriptRoot
git add server.js db.js admin-social-tracker.html
git commit -m "ig: pillarbox cover thumbnail, re-upload/remove buttons, page token fix, delete endpoint"
git push
