# Turtle and Sun

Express + PostgreSQL app. Entry point: `server.js`. Start with `npm start`.

## Environment variables

See `.env.example` for the full list. Notable one for visitor logging:

- `GEOIP_DB_PATH` — optional. Override the default GeoIP database location (`geoip/GeoLite2-City.mmdb`).

## GeoIP database (GeoLite2-City)

Visitor geolocation (country / region / city / lat / lng) uses MaxMind's free **GeoLite2-City** database via the `maxmind` package. The `.mmdb` file is **not** committed (it's gitignored) — download it yourself:

1. Create a free MaxMind account: https://www.maxmind.com/en/geolite2/signup
2. In your account, go to **Manage License Keys** and generate a license key.
3. Download **GeoLite2-City** (`.mmdb` format) from the **Download Files** page, or via the permalink:
   ```
   https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=YOUR_LICENSE_KEY&suffix=tar.gz
   ```
4. Extract the archive and place `GeoLite2-City.mmdb` at:
   ```
   geoip/GeoLite2-City.mmdb
   ```

If the file is missing, the app still runs — geo fields are simply logged as `null` and a warning is printed once at startup.

### Deploying the database to Railway

The `.mmdb` is gitignored, so it won't ship via git. Options:
- Commit-free deploy: upload the file to a Railway volume mounted at the `geoip/` path, **or**
- Set `GEOIP_DB_PATH` to a volume location and place the file there.

(MaxMind's license permits redistribution only with regular updates; a Railway volume keeps it out of the repo.)

## Visitor logging & admin viewer

- Every non-asset, non-`/webhook`, non-`/admin/*` request is logged to the `visits` table (async, never blocks the response).
- Old unflagged rows are purged daily at 03:00 UTC (90-day retention).
- Admin dashboard: **/admin/visits** (requires the `admin` role) — stat cards, filters, a Leaflet map, and a paginated table.
