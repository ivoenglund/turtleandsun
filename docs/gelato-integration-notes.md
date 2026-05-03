# Gelato Print Integration Notes

Internal dev notes for wiring up Gelato print-on-demand for Loveogram cards.
Last updated: 2026-05-03.

---

## API credentials (env vars)

| Var | Purpose |
|---|---|
| `GELATO_API_KEY` | API key from Gelato dashboard (Settings → API) |
| `GELATO_SANDBOX_MODE` | Set `true` to submit "draft" orders that don't ship (default true) |

In Railway: add both vars in the service environment. Never commit the key.

---

## Required address fields

Gelato's `shipTo` object needs all of the following:

```json
{
  "firstName": "Jane",
  "lastName":  "Doe",
  "addressLine1": "350 Fifth Avenue",
  "addressLine2": "",           // optional, omit if empty
  "city": "New York",
  "state": "NY",                // US state code; province code elsewhere
  "postCode": "10118",
  "country": "US",              // ISO 3166-1 alpha-2
  "email": "jane@example.com",
  "phone": "+12125551234"       // optional but recommended for courier
}
```

Fields that **will cause a rejected order** if missing: `firstName`, `lastName`,
`addressLine1`, `city`, `postCode`, `country`.

---

## Image format / resolution requirements

Gelato expects a **publicly accessible URL** pointing to the print-ready file.
For a 5×7 folded greeting card:

| Requirement | Value |
|---|---|
| Format | PDF (preferred) or JPEG / PNG |
| Colour space | CMYK for PDF; RGB accepted for JPEG/PNG (auto-converted) |
| Resolution | 300 DPI minimum; 350 DPI recommended |
| Bleed | 3 mm on all sides (include in file dimensions) |
| Safe zone | Keep text/logos 5 mm from trim edge |
| File size | < 100 MB |

Our FAL-generated images are JPEG at ~1024×1024 px (≈ 144 DPI at 5×7 in).
**This is below the 300 DPI minimum.** Before going live we need either:
- Upscale to 2100×1470 px (≈ 300 DPI) via an image pipeline step, or
- Switch to a high-res generation model / post-process with an upscaler.

---

## Product UIDs

The product UID must match a Gelato catalogue entry exactly.
Current placeholder in `gelato.js`:

```
cards_pf_5x7_pt_350-gsm-coated-silk_cl_4-4_hor
```

To confirm the correct UID:
1. Log in to Gelato dashboard → Product Catalogue → Cards
2. Select the card spec, copy the UID from the URL or API response
3. Update `CARD_PRODUCT_UID` in `gelato.js`

Common card UIDs (verify before use):

| Spec | UID pattern |
|---|---|
| 5×7 in, 350 gsm, folded | `cards_pf_5x7_pt_350-gsm-coated-silk_cl_4-4_hor` |
| A5, 350 gsm, folded | `cards_pf_a5_pt_350-gsm-coated-silk_cl_4-4_hor` |
| 4×6 in postcard flat | `cards_pf_4x6_pt_350-gsm-coated-silk_cl_4-0_hor` |

---

## Per-card cost ranges

Observed from sandbox API responses (USD, excl. shipping):

| Product | Print cost |
|---|---|
| 5×7 folded card (1 unit) | $1.80 – $2.50 |
| A5 folded card (1 unit) | $1.60 – $2.20 |
| Shipping (USPS First Class US) | $0.65 – $1.20 |

Costs vary by fulfilment centre and are included in the `pricing` array of
the order response. Check `items[].price` and `shipment.price` in the response.

---

## API response structure

A successful `POST /v4/orders` response (HTTP 200 / 201):

```json
{
  "id": "gelato-order-uuid",
  "orderReferenceId": "ts-test-12345-1746000000000",
  "orderType": "draft",
  "storeId": null,
  "currency": "USD",
  "status": "created",
  "fulfillmentStatus": "created",
  "financialStatus": "pending",
  "channel": "api",
  "items": [
    {
      "id": "item-uuid",
      "itemReferenceId": "item-1",
      "productUid": "cards_pf_5x7_pt_350-gsm-coated-silk_cl_4-4_hor",
      "quantity": 1,
      "status": "created",
      "previews": [],
      "price": 2.10,
      "currency": "USD"
    }
  ],
  "shipTo": { /* address echo */ },
  "shipment": {
    "id": "shipment-uuid",
    "price": 0.85,
    "currency": "USD",
    "method": "normal"
  },
  "receipts": [],
  "createdAt": "2026-05-03T12:00:00Z",
  "updatedAt": "2026-05-03T12:00:00Z"
}
```

Error response (e.g. 422 invalid address):
```json
{
  "code": "invalid_request",
  "message": "Validation error",
  "details": [ { "field": "shipTo.postCode", "message": "required" } ]
}
```

---

## Contacts table changes needed for production printing

To automate sending a Loveogram to a contact's address, the contacts table
needs the following (most already exist, noted below):

| Column | Status | Notes |
|---|---|---|
| `name` | ✅ exists | Split into `firstName`/`lastName` at send time |
| `street` | ✅ exists | → `addressLine1` |
| `street_2` | ✅ exists | → `addressLine2` |
| `city` | ✅ exists | |
| `region` | ✅ exists | → `state` (US) or province code |
| `postal_code` | ✅ exists | → `postCode` |
| `country` | ✅ exists | Verify it stores ISO codes, not full names |
| `phone` | ✅ exists | Optional for Gelato but useful |
| `email` | ✅ exists | |
| `gelato_recipient_verified` | ❌ missing | Boolean — address confirmed printable |
| `preferred_card_format` | ❌ missing | e.g. `5x7`, `A5`; default to 5×7 |

Add a migration in `db.js` when ready:
```sql
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS gelato_recipient_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS preferred_card_format TEXT DEFAULT '5x7';
```

---

## Next steps before production

1. Confirm `CARD_PRODUCT_UID` against live Gelato catalogue
2. Upscale generated images to ≥ 300 DPI before submitting
3. Validate country field stores ISO-3166 codes (not "United States")
4. Implement address verification step in the contact edit flow
5. Switch `GELATO_SANDBOX_MODE` to `false` in production Railway env
6. Store Gelato order ID in the `orders` table for status tracking
   (add column `gelato_order_id TEXT`)
