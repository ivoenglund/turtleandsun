@echo off
cd /d C:\turtleandsun
if exist .git\index.lock del /q /f .git\index.lock
git add -A
git commit -m "fix: use DragEvent drop on div.upload for TikTok video fill"
git push origin main
pause
