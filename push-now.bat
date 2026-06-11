@echo off
del /f /q "C:\turtleandsun\.git\index.lock" 2>nul
del /f /q "C:\turtleandsun\.git\refs\heads\main.lock" 2>nul
cd /d C:\turtleandsun
git add admin-social-tracker.html
git commit -m "Shared coordinate system: table + bottom-panel inside single 844px tracker-block"
git push
pause
