@echo off
cd /d C:\turtleandsun
if exist .git\index.lock del /q /f .git\index.lock
git add -A
git commit -m "feat: drag video from admin directly into TikTok Studio via DownloadURL"
git push origin main
pause
