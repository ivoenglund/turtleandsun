-- ============================================================================
-- Occasions engine migration  (design 2026-05-30; run POST-LAUNCH)
-- Adds national/location occasions + a campaign send/print queue.
-- Personal occasions already live in the existing `occasions` table.
-- Idempotent: safe to run repeatedly (CREATE IF NOT EXISTS / ON CONFLICT).
-- markets: ISO 3166-1 alpha-2 country codes (GB=UK). weekday: 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat
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

-- ---- Seed: 36 national/location occasions (explicit market lists) --------

INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-no','Mother''s Day — Norway','mothers_day','["NO"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 2, "weekday": 0, "nth": 2}'::jsonb,'Earliest Mother''s Day of the year.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('valentine','Valentine''s Day','couples','["US", "CA", "AU", "AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT", "XK", "LV", "LI", "LT", "LU", "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL", "PT", "RO", "RU", "SM", "RS", "SK", "SI", "ES", "SE", "CH", "TR", "UA", "GB", "VA"]'::jsonb,'fixed','{"type": "fixed", "month": 2, "day": 14}'::jsonb,'Couples / romantic portraits; strong last-minute digital.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('womens-8mar','Women''s / Mother''s Day (8 Mar)','mothers_day','["AL", "BA", "BG", "XK", "MD", "ME", "MK", "RS"]'::jsonb,'fixed','{"type": "fixed", "month": 3, "day": 8}'::jsonb,'8 Mar is the mothers/women gifting day in E. Europe/Balkans.','Med','verify')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-ukie','Mother''s Day — UK & Ireland','mothers_day','["GB", "IE"]'::jsonb,'easter_offset','{"type": "easter_offset", "days": -21}'::jsonb,'Mothering Sunday — moves yearly, ~3 wks before Easter.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-stjoseph','Father''s Day — St Joseph','fathers_day','["AD", "BA", "HR", "IT", "ME", "PT", "SM", "SI", "ES", "VA"]'::jsonb,'fixed','{"type": "fixed", "month": 3, "day": 19}'::jsonb,'Catholic-Europe Father''s Day; dad portraits.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-si','Mother''s Day — Slovenia','mothers_day','["SI"]'::jsonb,'fixed','{"type": "fixed", "month": 3, "day": 25}'::jsonb,'Fixed 25 March.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('easter','Easter (Western)','seasonal','["US", "CA", "AU", "AL", "AD", "AT", "BE", "BA", "HR", "CZ", "DK", "EE", "FI", "FR", "DE", "HU", "IS", "IE", "IT", "XK", "LV", "LI", "LT", "LU", "MT", "MC", "NL", "NO", "PL", "PT", "SM", "SK", "SI", "ES", "SE", "CH", "TR", "GB", "VA"]'::jsonb,'easter_offset','{"type": "easter_offset", "days": 0}'::jsonb,'Family-gathering + spring/pet themes. Western-calendar markets.','Low-Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-1sun-may','Mother''s Day — 1st Sun May','mothers_day','["AD", "HU", "LT", "PT", "RO", "ES"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 5, "weekday": 0, "nth": 1}'::jsonb,'First of the May Mother''s Day waves.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-2sun-may','Mother''s Day — 2nd Sun May (BIG)','mothers_day','["US", "CA", "AU", "AT", "BE", "HR", "CY", "CZ", "DK", "EE", "FI", "DE", "GR", "IS", "IT", "LV", "LI", "MT", "NL", "SM", "SK", "CH", "TR", "UA", "VA"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 5, "weekday": 0, "nth": 2}'::jsonb,'One of the two biggest gifting days worldwide.','Peak','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-ro','Father''s Day — Romania','fathers_day','["RO"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 5, "weekday": 0, "nth": 2}'::jsonb,'2nd Sun May, a week after RO Mother''s Day.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-de','Father''s Day — Germany (Ascension)','fathers_day','["DE"]'::jsonb,'easter_offset','{"type": "easter_offset", "days": 39}'::jsonb,'Vatertag = Ascension Thursday.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-pl','Mother''s Day — Poland','mothers_day','["PL"]'::jsonb,'fixed','{"type": "fixed", "month": 5, "day": 26}'::jsonb,'Fixed 26 May (Dzien Matki).','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-lastsun-may','Mother''s Day — last Sun May','mothers_day','["SE", "FR", "MC"]'::jsonb,'last_weekday','{"type": "last_weekday", "month": 5, "weekday": 0}'::jsonb,'Sweden + France (France shifts to 1st Sun Jun if Pentecost).','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-dk','Father''s Day — Denmark','fathers_day','["DK"]'::jsonb,'fixed','{"type": "fixed", "month": 6, "day": 5}'::jsonb,'5 Jun, also Constitution Day.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-1sun-jun','Father''s Day — 1st Sun Jun','fathers_day','["LT", "CH"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 6, "weekday": 0, "nth": 1}'::jsonb,'Dad portraits.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-2sun-jun','Father''s Day — 2nd Sun Jun','fathers_day','["AT", "BE", "LI"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 6, "weekday": 0, "nth": 2}'::jsonb,'Dad portraits.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-lu','Mother''s Day — Luxembourg','mothers_day','["LU"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 6, "weekday": 0, "nth": 2}'::jsonb,'Late Mother''s Day (2nd Sun June).','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-3sun-jun','Father''s Day — 3rd Sun Jun (BIG)','fathers_day','["US", "CA", "GB", "IE", "AL", "CY", "CZ", "FR", "GR", "HU", "MT", "MC", "NL", "SK", "TR", "UA"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 6, "weekday": 0, "nth": 3}'::jsonb,'Biggest Father''s Day; dad + pet-and-dad.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-pl','Father''s Day — Poland','fathers_day','["PL"]'::jsonb,'fixed','{"type": "fixed", "month": 6, "day": 23}'::jsonb,'Fixed 23 June.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-au','Father''s Day — Australia','fathers_day','["AU"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 9, "weekday": 0, "nth": 1}'::jsonb,'AU-ONLY September date — never send in June.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('gp-us','Grandparents Day — US','family','["US"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 9, "weekday": 0, "nth": 2}'::jsonb,'Multi-generation ''whole family'' angle.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-lv','Father''s Day — Latvia','fathers_day','["LV"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 9, "weekday": 0, "nth": 2}'::jsonb,'2nd Sun September.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-lu','Father''s Day — Luxembourg','fathers_day','["LU"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 10, "weekday": 0, "nth": 1}'::jsonb,'1st Sun October.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('tg-ca','Thanksgiving — Canada','family','["CA"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 10, "weekday": 1, "nth": 2}'::jsonb,'Family gathering; lighter gifting.','Low-Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-by','Mother''s Day — Belarus','mothers_day','["BY"]'::jsonb,'fixed','{"type": "fixed", "month": 10, "day": 14}'::jsonb,'Fixed 14 October.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-ru','Father''s Day — Russia','fathers_day','["RU"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 10, "weekday": 0, "nth": 3}'::jsonb,'3rd Sun October (official).','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-by','Father''s Day — Belarus','fathers_day','["BY"]'::jsonb,'fixed','{"type": "fixed", "month": 10, "day": 21}'::jsonb,'Fixed 21 October.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('halloween','Halloween','seasonal','["US", "GB", "CA", "AU", "IE"]'::jsonb,'fixed','{"type": "fixed", "month": 10, "day": 31}'::jsonb,'Pet-costume concepts — ~5x viral coefficient.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-nordic','Father''s Day — Nordics','fathers_day','["SE", "NO", "FI", "EE", "IS"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 11, "weekday": 0, "nth": 2}'::jsonb,'Nordic Fars dag, 2nd Sun November.','High','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('tg-us','Thanksgiving — US','family','["US"]'::jsonb,'nth_weekday','{"type": "nth_weekday", "month": 11, "weekday": 4, "nth": 4}'::jsonb,'Opens the Black Friday / holiday window.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('md-ru','Mother''s Day — Russia','mothers_day','["RU"]'::jsonb,'last_weekday','{"type": "last_weekday", "month": 11, "weekday": 0}'::jsonb,'Last Sun November.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('stnicholas','St Nicholas (5-6 Dec)','seasonal','["NL", "BE", "LU"]'::jsonb,'fixed','{"type": "fixed", "month": 12, "day": 6}'::jsonb,'Main kids'' gift day in the Low Countries (NL 5 Dec).','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('fd-bg','Father''s Day — Bulgaria','fathers_day','["BG"]'::jsonb,'fixed','{"type": "fixed", "month": 12, "day": 26}'::jsonb,'Fixed 26 December.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('christmas','Christmas (24-25 Dec)','seasonal','["US", "CA", "AU", "AL", "AD", "AT", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT", "XK", "LV", "LI", "LT", "LU", "MT", "MC", "NL", "NO", "PL", "PT", "RO", "SM", "SK", "SI", "ES", "SE", "CH", "TR", "UA", "GB", "VA"]'::jsonb,'fixed','{"type": "fixed", "month": 12, "day": 25}'::jsonb,'Biggest revenue window. Gift day 24 vs 25 by market; honour print cut-offs.','Peak','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('threekings','Three Kings (6 Jan)','seasonal','["ES", "IT", "AD"]'::jsonb,'fixed','{"type": "fixed", "month": 1, "day": 6}'::jsonb,'Reyes/Befana — main kids'' gift day in ES, IT & Andorra.','Med','ok')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('orthodox-xmas','Orthodox Christmas (7 Jan)','seasonal','["RS", "ME", "MK", "RU", "MD", "BY"]'::jsonb,'fixed','{"type": "fixed", "month": 1, "day": 7}'::jsonb,'Julian-calendar Christmas.','Med','verify')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO holiday_occasions (slug,name,occasion_type,markets,rule_type,rule_params,content_angle,priority,confidence) VALUES
  ('new-year','New Year (1 Jan)','seasonal','["US", "CA", "AU", "AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT", "XK", "LV", "LI", "LT", "LU", "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL", "PT", "RO", "RU", "SM", "RS", "SK", "SI", "ES", "SE", "CH", "TR", "UA", "GB", "VA"]'::jsonb,'fixed','{"type": "fixed", "month": 1, "day": 1}'::jsonb,'New Year greeting/offer. PRIMARY gift-giving day in Russia, Turkey, Belarus & Ukraine (where Christmas is not). Fresh-start / family angle elsewhere.','High','ok')
ON CONFLICT (slug) DO NOTHING;
