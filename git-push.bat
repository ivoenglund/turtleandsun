@echo off
cd /d C:\turtleandsun
if exist .git\index.lock del /q /f .git\index.lock
git add -A
git commit -m "feat: local helper saves video to C:\TikTok folder"
git push origin main
pause
