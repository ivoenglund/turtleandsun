@echo off
cd /d C:\turtleandsun
if exist .git\index.lock del /q /f .git\index.lock
git add -A
git commit -m "feat: copy buttons for caption/hashtags + download video in TikTok modal"
git push origin main
pause
