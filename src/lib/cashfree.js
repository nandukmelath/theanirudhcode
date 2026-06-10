// Cashfree PG — REST API v2023-08-01
// Uses native fetch (Node 20+). No extra dependencies.

const SANDBOX_BASE    = 'https://sandbox.cashfree.com/pg';
const PRODUCTION_BASE = 'https://api.cashfree.com/pg';

function base() {
  return process.env.CASHFREE_ENV === 'production' ? PRODUCTION_BASE : SANDBOX_BASE;
}

function apiHeaders() {
  if (!process.env.CASHFREE_APP_ID || !process.env.CASHFREE_SECRET_KEY) {
    throw new Error('CASHFREE_APP_ID / CASHFREE_SECRET_KEY not set in env');
  }
  return {
    'x-api-version':   '2023-08-01',
    'x-client-id':     process.env.CASHFREE_APP_ID,
    'x-client-secret': process.env.CASHFREE_SECRET_KEY,
    'Content-Type':    'application/json',
  };
}

async function cashfreeRequest(method, path, body) {
  const res = await fetch(`${base()}${path}`, {
    method,
    headers: apiHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.message || `Cashfree API error ${res.status}`);
    err.status = res.status;
    err.code   = data.code;
    throw err;
  }
  return data;
}

async function createOrder(payload) {
  return cashfreeRequest('POST', '/orders', payload);
}

async function getOrder(orderId) {
  return cashfreeRequest('GET', `/orders/${encodeURIComponent(orderId)}`);
}

async function getOrderPayments(orderId) {
  return cashfreeRequest('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
}

module.exports = { createOrder, getOrder, getOrderPayments };
