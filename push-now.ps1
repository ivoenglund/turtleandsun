Remove-Item "C:\turtleandsun\.git\index.lock" -Force -ErrorAction SilentlyContinue
Remove-Item "C:\turtleandsun\.git\refs\heads\main.lock" -Force -ErrorAction SilentlyContinue
Set-Location C:\turtleandsun
git add admin-social-tracker.html
git commit -m "Full width tracker-block, gap above panel, uniform row height in totals"
git push
