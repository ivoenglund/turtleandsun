@echo off
cd /d C:\turtleandsun
if exist .git\index.lock del /q /f .git\index.lock
git add -A
git commit -m "feat: TikTok auto-fill Chrome extension + admin button"
git push origin main
pause
