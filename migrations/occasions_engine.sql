-- ============================================================================
-- Occasions engine migration  (design 2026-05-30; run POST-LAUNCH)
-- Adds national/location occasions + a campaign send/print queue.
-- Personal occasions already live in the existing `occasions` table.
-- Idempotent: safe to run repeatedly (CREATE IF NOT EXISTS / ON CONFLICT).
-- weekday: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
-- ============================================================================

CREATE TABLE IF NOT EXISTS holiday_occasions (
  id            SERIAL PRIMARY KEY,
  slug          VARCHAR(64) UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  occasion_type TEXT NOT NULL,                  -- mothers_day | fathers_day | couples | family | seasonal
  markets       JSONB NOT NULL DEFAULT '[]',    -- country names this occasion applies to (normalise to ISO before agent use)
  rule_type     TEXT NOT NULL,                  -- fixed | nth_weekday | last_weekday | easter_offset
  rule_params   JSONB NOT NULL,                 -- params consumed by the date-resolver
  content_angle TEXT,
  priority      TEXT,
  confidence    TEXT NOT NULL DEFAULT 'ok',     -- ok | verify
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_queue (
  id                  SERIAL PRIMARY KEY,
  source_type         TEXT NOT NULL CHECK (source_type IN ('national','personal')),
  holiday_occasion_id INTEGER REFERENCES holiday_occasions(id),
  occasion_id         INTEGER REFERENCES occasions(id),   -- personal occasion (existing table)
  user_id             INTEGER REFERENCES users(id),
  contact_id          INTEGER REFERENCES contacts(id),
  market              TEXT,
  occasion_date       DATE NOT NULL,                      -- concrete computed date for this cycle
  channel             TEXT NOT NULL CHECK (channel IN ('email','print','social')),
  concept_id          INTEGER REFERENCES concepts(id),
  subject             TEXT,
  body                TEXT,
  asset_url           TEXT,
  status              TEXT NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','drafted','scheduled','sent','skipped','failed')),
  scheduled_for       DATE,
  send_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (source_type, holiday_occasion_id, market, channel, occasion_date)
);

CREATE INDEX IF NOT EXISTS idx_holiday_occasions_active ON holiday_occasions(active) WHERE active = true;
CREATE INDEX IF NOT EXISTS idx_campaign_queue_status ON campaign_queue(status);
CREATE INDEX IF NOT EXISTS idx_campaign_queue_date ON campaign_queue(occasion_date);

-- ---- Seed: 36 national/location occasions -----------------------------------

INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-no','Mother''s Day — Norway','mothers_day','["Norway"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 2, "weekday": 0, "nth": 2}'::jsonb,'Earliest Mother''s Day of the year.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('valentine','Valentine''s Day','couples','["US", "UK", "Canada", "Australia", "Ireland", "+ most markets"]'::jsonb,'fixed','{"type": "fixed", "month": 2, "day": 14}'::jsonb,'Couples / romantic portraits; strong last-minute digital.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('womens-8mar','Women''s / Mother''s Day (8 Mar)','mothers_day','["Albania", "Bulgaria", "Bosnia & Herzegovina", "Kosovo", "Moldova", "Montenegro", "North Macedonia", "Serbia"]'::jsonb,'fixed','{"type": "fixed", "month": 3, "day": 8}'::jsonb,'8 Mar is the mothers/women gifting day in E. Europe/Balkans.','Med','verify')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-ukie','Mother''s Day — UK & Ireland','mothers_day','["UK", "Ireland"]'::jsonb,'easter_offset','{"type": "easter_offset", "days": -21}'::jsonb,'Mothering Sunday — moves yearly, ~3 wks before Easter.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-stjoseph','Father''s Day — St Joseph','fathers_day','["Spain", "Italy", "Portugal", "Croatia", "Slovenia", "Andorra", "San Marino", "Vatican City"]'::jsonb,'fixed','{"type": "fixed", "month": 3, "day": 19}'::jsonb,'Catholic-Europe Father''s Day; dad portraits.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-si','Mother''s Day — Slovenia','mothers_day','["Slovenia"]'::jsonb,'fixed','{"type": "fixed", "month": 3, "day": 25}'::jsonb,'Fixed 25 March.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('easter','Easter (Western)','seasonal','["+ all Western-calendar markets"]'::jsonb,'easter_offset','{"type": "easter_offset", "days": 0}'::jsonb,'Family-gathering + spring/pet themes.','Low-Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-1sun-may','Mother''s Day — 1st Sun May','mothers_day','["Spain", "Portugal", "Hungary", "Lithuania", "Romania", "Andorra"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 5, "weekday": 0, "nth": 1}'::jsonb,'First of the May Mother''s Day waves.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-2sun-may','Mother''s Day — 2nd Sun May (BIG)','mothers_day','["US", "Canada", "Australia", "Austria", "Belgium", "Croatia", "Cyprus", "Czechia", "Denmark", "Estonia", "Finland", "Germany", "Greece", "Iceland", "Italy", "Latvia", "Malta", "Netherlands", "San Marino", "Slovakia", "Switzerland", "Turkey", "Ukraine"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 5, "weekday": 0, "nth": 2}'::jsonb,'One of the two biggest gifting days worldwide.','Peak','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-ro','Father''s Day — Romania','fathers_day','["Romania"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 5, "weekday": 0, "nth": 2}'::jsonb,'2nd Sun May, a week after RO Mother''s Day.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-de','Father''s Day — Germany (Ascension)','fathers_day','["Germany"]'::jsonb,'easter_offset','{"type": "easter_offset", "days": 39}'::jsonb,'Vatertag = Ascension Thursday.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-pl','Mother''s Day — Poland','mothers_day','["Poland"]'::jsonb,'fixed','{"type": "fixed", "month": 5, "day": 26}'::jsonb,'Fixed 26 May (Dzien Matki).','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-lastsun-may','Mother''s Day — last Sun May','mothers_day','["Sweden", "France", "Monaco"]'::jsonb,'last_weekday','{"type": "last_weekday", "month": 5, "weekday": 0}'::jsonb,'Sweden + France (France shifts to 1st Sun Jun if Pentecost).','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-dk','Father''s Day — Denmark','fathers_day','["Denmark"]'::jsonb,'fixed','{"type": "fixed", "month": 6, "day": 5}'::jsonb,'5 Jun, also Constitution Day.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-1sun-jun','Father''s Day — 1st Sun Jun','fathers_day','["Lithuania", "Switzerland"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 6, "weekday": 0, "nth": 1}'::jsonb,'Dad portraits.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-2sun-jun','Father''s Day — 2nd Sun Jun','fathers_day','["Austria", "Belgium", "Liechtenstein"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 6, "weekday": 0, "nth": 2}'::jsonb,'Dad portraits.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-lu','Mother''s Day — Luxembourg','mothers_day','["Luxembourg"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 6, "weekday": 0, "nth": 2}'::jsonb,'Late Mother''s Day (2nd Sun June).','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-3sun-jun','Father''s Day — 3rd Sun Jun (BIG)','fathers_day','["US", "Canada", "UK", "Ireland", "France", "Greece", "Hungary", "Malta", "Netherlands", "Slovakia", "Turkey", "Ukraine", "Cyprus", "Czechia", "Monaco"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 6, "weekday": 0, "nth": 3}'::jsonb,'Biggest Father''s Day; dad + pet-and-dad.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-pl','Father''s Day — Poland','fathers_day','["Poland"]'::jsonb,'fixed','{"type": "fixed", "month": 6, "day": 23}'::jsonb,'Fixed 23 June.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-au','Father''s Day — Australia','fathers_day','["Australia"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 9, "weekday": 0, "nth": 1}'::jsonb,'AU-ONLY September date — never send in June.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('gp-us','Grandparents Day — US','family','["US"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 9, "weekday": 0, "nth": 2}'::jsonb,'Multi-generation ''whole family'' angle.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-lv','Father''s Day — Latvia','fathers_day','["Latvia"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 9, "weekday": 0, "nth": 2}'::jsonb,'2nd Sun September.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-lu','Father''s Day — Luxembourg','fathers_day','["Luxembourg"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 10, "weekday": 0, "nth": 1}'::jsonb,'1st Sun October.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('tg-ca','Thanksgiving — Canada','family','["Canada"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 10, "weekday": 1, "nth": 2}'::jsonb,'Family gathering; lighter gifting.','Low-Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-by','Mother''s Day — Belarus','mothers_day','["Belarus"]'::jsonb,'fixed','{"type": "fixed", "month": 10, "day": 14}'::jsonb,'Fixed 14 October.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-ru','Father''s Day — Russia','fathers_day','["Russia"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 10, "weekday": 0, "nth": 3}'::jsonb,'3rd Sun October (official).','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-by','Father''s Day — Belarus','fathers_day','["Belarus"]'::jsonb,'fixed','{"type": "fixed", "month": 10, "day": 21}'::jsonb,'Fixed 21 October.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('halloween','Halloween','seasonal','["US", "UK", "Canada", "Australia", "Ireland"]'::jsonb,'fixed','{"type": "fixed", "month": 10, "day": 31}'::jsonb,'Pet-costume concepts — ~5x viral coefficient.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-nordic','Father''s Day — Nordics','fathers_day','["Sweden", "Norway", "Finland", "Estonia", "Iceland"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 11, "weekday": 0, "nth": 2}'::jsonb,'Nordic Fars dag, 2nd Sun November.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('tg-us','Thanksgiving — US','family','["US"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 11, "weekday": 4, "nth": 4}'::jsonb,'Opens the Black Friday / holiday window.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-ru','Mother''s Day — Russia','mothers_day','["Russia"]'::jsonb,'last_weekday','{"type": "last_weekday", "month": 11, "weekday": 0}'::jsonb,'Last Sun November.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('stnicholas','St Nicholas (5-6 Dec)','seasonal','["Netherlands", "Belgium", "Luxembourg"]'::jsonb,'fixed','{"type": "fixed", "month": 12, "day": 6}'::jsonb,'Main kids'' gift day in the Low Countries (NL 5 Dec).','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-bg','Father''s Day — Bulgaria','fathers_day','["Bulgaria"]'::jsonb,'fixed','{"type": "fixed", "month": 12, "day": 26}'::jsonb,'Fixed 26 December.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('christmas','Christmas (24-25 Dec)','seasonal','["+ all markets"]'::jsonb,'fixed','{"type": "fixed", "month": 12, "day": 25}'::jsonb,'Biggest revenue window. Gift day 24 vs 25 by market; honour print cut-offs.','Peak','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('threekings','Three Kings (6 Jan)','seasonal','["Spain", "Italy"]'::jsonb,'fixed','{"type": "fixed", "month": 1, "day": 6}'::jsonb,'Reyes/Befana — main kids'' gift day in ES & IT.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('orthodox-xmas','Orthodox Christmas (7 Jan)','seasonal','["Serbia", "Russia", "Montenegro", "North Macedonia", "Moldova"]'::jsonb,'fixed','{"type": "fixed", "month": 1, "day": 7}'::jsonb,'Julian-calendar Christmas.','Med','verify')
ON CONFLICT (slug) DO NOTHING;
