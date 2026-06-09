@echo off
cd /d C:\turtleandsun
if exist .git\index.lock del /q /f .git\index.lock
git add -A
git commit -m "fix: update TikTok extension URL to tiktokstudio/upload"
git push origin main
pause
