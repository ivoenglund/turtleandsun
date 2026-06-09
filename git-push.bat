@echo off
cd /d C:\turtleandsun
if exist .git\index.lock del /q /f .git\index.lock
git add -A
git commit -m "feat: route TikTok upload through Buffer API"
git push origin main
pause
