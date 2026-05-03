'use strict';

const GELATO_API_KEY = process.env.GELATO_API_KEY;
const GELATO_SANDBOX = process.env.GELATO_SANDBOX_MODE !== 'false'; // default true
const GELATO_BASE = 'https://order.gelatoapis.com';

// 5×7 inch folded greeting card, 350 gsm coated silk, full-colour both sides.
// Confirm this UID in the Gelato product catalogue before going live.
const CARD_PRODUCT_UID = 'cards_pf_5x7_pt_350-gsm-coated-silk_cl_4-4_hor';

const TEST_ADDRESS = {
  firstName: 'Turtle',
  lastName: 'Test',
  addressLine1: '350 Fifth Avenue',
  city: 'New York',
  state: 'NY',
  postCode: '10118',
  country: 'US',
  email: 'test@turtleandsun.com',
  phone: '+12125551234',
};

async function testPrint(imageUrl, sourceOrderId) {
  if (!GELATO_API_KEY) throw new Error('GELATO_API_KEY env var not set');

  const ref = `ts-test-${sourceOrderId || 'manual'}-${Date.now()}`;
  const requestBody = {
    orderType: GELATO_SANDBOX ? 'draft' : 'order',
    orderReferenceId: ref,
    customerReferenceId: ref,
    currency: 'USD',
    items: [
      {
        itemReferenceId: 'item-1',
        productUid: CARD_PRODUCT_UID,
        quantity: 1,
        files: [
          { type: 'default', url: imageUrl },
        ],
      },
    ],
    shipTo: TEST_ADDRESS,
  };

  const resp = await fetch(`${GELATO_BASE}/v4/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': GELATO_API_KEY,
    },
    body: JSON.stringify(requestBody),
  });

  const responseBody = await resp.json().catch(() => ({}));
  return {
    ok: resp.ok,
    httpStatus: resp.status,
    sandbox: GELATO_SANDBOX,
    requestBody,
    responseBody,
  };
}

module.exports = { testPrint, TEST_ADDRESS, CARD_PRODUCT_UID };
