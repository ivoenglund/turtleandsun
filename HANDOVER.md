# Turtle & Sun — Session Handover
**Date:** 2026-06-16  
**Project:** turtleandsun — family calendar web app  
**Primary file edited this session:** `print-calendar.html`

---

## Security rules — never forget these

- Never paste secrets (`sk_/re_/whsec_/postgres://`) into chat — `.env` / Railway only
- `server.js` has LF line endings — edit with Python or bash only. Never use the Edit tool on it.
- `db.js` must NEVER be edited with the Edit tool
- `print-calendar.html` must NEVER be edited with the Edit tool — Python scripts only
- Don't tell Ivo to stop/sleep. Short, direct answers.

---

## What was done this session

### 1. Holiday icon system (print-calendar.html)

Added a comprehensive `holidayIcon(name)` function that maps holiday names to emoji. The mapping was built by reading the actual Nager.Date C# source providers on GitHub (SE, US, DE, FR, NO, AU, JP, KR, BR, CN, MX, CA, NL) to get the exact `EnglishName` strings the API returns.

Covers 80+ patterns across:
- Christian/Western: Christmas 🎄, Easter 🐣, Good Friday ✝️, Maundy Thursday 🫙, Ascension ☁️, Pentecost 🕊️, **Whit Monday 🕊️** (was missing — "whitsun" didn't match "Whit Monday"), **St. Stephen's Day / Boxing Day 🎁** (was missing), Epiphany ⭐, All Saints 🕯️, All Souls 🕯️, Assumption 🌸, Corpus Christi ✝️, Advent ✨, St. Lucia 🕯️, Carnival 🎭
- New Year variants: 🎆 Western, 🧧 Chinese/Lunar, 🌸 Nowruz, 💦 Songkran, 🌙 Islamic
- Islamic: Eid al-Fitr 🌙, Eid al-Adha 🐑, Ramadan 🌙, Mawlid 🌙, Ashura 🕯️
- Jewish: Hanukkah 🕎, Rosh Hashanah 🍎, Yom Kippur 🙏, Passover 🫓, Purim 🎭, Shavuot 📜, Sukkot 🌿, Hanukkah 🕎
- Hindu: Diwali 🪔, Holi 🎨, Ganesh 🐘, Onam 🌸, Pongal 🌾
- Buddhist/Sikh: Vesak 🙏, Baisakhi 🌾, Guru Nanak 🙏
- Japan-specific: Vernal/Autumnal Equinox 🌸/🍂, Shōwa Day 🌸, Greenery Day 🌿, Marine Day 🌊, Mountain Day ⛰️, Children's Day 🎏, Coming of Age 🎓, Culture Day 🎭, Labour Thanksgiving 🍂, Emperor's Birthday 👑, Sports Day 🏃
- Korea-specific: Chuseok 🌕, Hangul Day 📝
- China-specific: Dragon Boat 🐉, Mid-Autumn 🌕
- Scandinavia: Midsummer ☀️, Walpurgis 🔥, St. Lucia 🕯️, National Day of Sweden 🇸🇪
- US-specific: MLK Day 🕊️, Presidents Day 🏛️, Memorial Day 🎗️, Juneteenth ✊, Indigenous Peoples' Day 🪶, Columbus Day 🚢, Veterans Day 🎗️, Thanksgiving 🦃
- Australia: Australia Day 🦘, Anzac Day 🎗️, Melbourne Cup 🐎, Picnic Day 🧺, AFL Grand Final 🏉
- Canada: Canada Day 🍁, Family Day 👪, Victoria Day 👑, Truth & Reconciliation 🤝
- Royal: King's Day / King's Birthday / Queen's Birthday → 👑
- Civic: Independence Day 🎆, Liberation Day ✌️, Victory in Europe Day ✌️, Constitution Day 📜, German Unity Day 🤝, Labour Day ✊, Women's Day 👩, Earth Day 🌍
- Fallback: 📅

### 2. Event type icon system

`eventIcon(type, label)` dispatches to type-specific functions:

**`birthdayIcon(label)`** — milestone-aware:
- 👶 newborn (0), 🍼 toddler (1–4), 🎈 child/teen (5–17), 🎉 18th, 🥂 21st, 🌟 25th, 🎯 30th, 💫 40th, 🏅 50th, 🌈 60th, 💐 70th, 👑 75/80/90, 🏆 100+, 🎂 all others
- Age extracted from label format `"Name, 42 years"` via regex `/(\d+)\s+years?/`

**`milestoneIcon(label)`** — keyword-aware:
- 💼 work/career, 🎓 school, 🏃 running/race, 💪 health/sobriety, ⭐ general

**`occasionIcon(name)`** — expanded keyword list:
- 💍 engagement/wedding, 💝 anniversary, 💑 first date/dating, 💔 divorce
- 👶 baby/adoption, ⛪ baptism, ✡️ bar/bat mitzvah, ✝️ confirmation
- 🎓 graduation, 🏖️ retirement, 💼 new job/promotion, 🏠 new home, 🚗 new car
- 🏥 surgery, 💪 sobriety/recovery, 🏃 marathon, 🏆 award/prize, 🎉 fallback

**Remembrance:** 🕊️ (fixed)

### 3. Icon size — 50% bigger

All icons wrapped in `<span class="ev-icon">`. CSS:
```css
.ev-icon { font-size: 1.5em; line-height: 1; vertical-align: middle; margin-right: 1px; }
```
Applied in both screen CSS and `@media print`.

### 4. Bug fix — birthday icons weren't showing

Root cause: birthday events are built with `html:` property (to support photo thumbnails). The cell renderer checks `e.html !== undefined` and skips `eventIcon()` when set. Fix: call `birthdayIcon(label)` at event-build time and prepend `<span class="ev-icon">` into `eventHtml` directly (lines ~452–464 in print-calendar.html).

---

## Current state of all features in print-calendar.html

| Feature | Status |
|---|---|
| Grid / Tile designs (Design dropdown) | ✅ Done |
| Week numbers checkbox | ✅ Done |
| Landscape A4 preview | ✅ Done |
| Public holidays (country dropdown, per-user pref, DB cache) | ✅ Done |
| Holiday show/hide toggle | ✅ Done |
| Birthday events with contact name + age | ✅ Done |
| Occasion events with contact name + years count | ✅ Done |
| Remembrance events | ✅ Done |
| Milestone events | ✅ Done |
| Past calendar guard (no negative-age events) | ✅ Done |
| Default view = single month | ✅ Done |
| Emoji icons for all event types | ✅ Done this session |
| Emoji icons for 80+ holidays | ✅ Done this session |
| Milestone birthday icons (age-aware) | ✅ Done this session |
| Icons 50% bigger | ✅ Done this session |

---

## Pending git commits

All session work is staged/committed but **HEAD.lock** on Windows blocks pushing from bash. Always run in PowerShell before each push:

```powershell
Remove-Item C:\turtleandsun\.git\HEAD.lock -Force
cd C:\turtleandsun
git push
```

Commits to push from this session:
1. `feat: emoji icons for all event types and holidays`
2. `feat: comprehensive holiday icon mapping from Nager.Date source`
3. `feat: milestone birthday icons, expanded occasion and milestone icons`
4. `fix: birthday icons now show; icons 50% bigger via ev-icon span`

---

## Architecture reminder

- **`print-calendar.html`** — all calendar UI, rendering, icons (Python edits only)
- **`server.js`** — Express backend, holiday API endpoints, user settings (Python/bash edits only, LF line endings)
- **`db.js`** — DB schema + migrations (Python/bash edits only)
- **Holiday cache:** in-process `_memHolidays` → PostgreSQL `holiday_cache` table → Nager.Date API (30-day TTL)
- **Holiday names source of truth:** https://github.com/nager/Nager.Date/tree/main/src/Nager.Date/HolidayProviders

---

## Possible next features (Ivo's ideas, not yet started)

- Nothing explicitly requested beyond icons — session ended after icon work was complete
