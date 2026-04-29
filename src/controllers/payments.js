/**
 * Payment controller — Razorpay (INR/India) + Stripe (USD/International)
 *
 * TEST MODE: set PAYMENT_TEST_MODE=true in env to bypass real gateways.
 * Everything works end-to-end. Flip off when real keys are added.
 *
 * Routes:
 *   POST /api/payments/razorpay/create-order
 *   POST /api/payments/razorpay/verify
 *   POST /api/payments/stripe/create-session
 *   POST /api/payments/stripe/webhook
 *   POST /api/payments/test/complete            ← test mode only
 */
const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const prisma   = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');
const { sanitize }     = require('../middleware/validate');
const wa               = require('../lib/whatsapp');
const { createCalendarEvent } = require('./calendar');

const TEST_MODE        = process.env.PAYMENT_TEST_MODE === 'true';
const RAZORPAY_READY   = !!(process.env.RAZORPAY_KEY_ID   && !process.env.RAZORPAY_KEY_ID.includes('REPLACE'));
const STRIPE_READY     = !!(process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('REPLACE'));

// ── Pricing ────────────────────────────────────────────────────────────────────
// Prices must match what Razorpay/Stripe receives (Razorpay: paise, Stripe: cents)
const PRICES = {
  discovery:     { label: '30-min Discovery',     INR: 1500,  USD: 18,  durationMin: 30  },
  deepdive:      { label: '60-min Deep Dive',     INR: 5000,  USD: 60,  durationMin: 60  },
  comprehensive: { label: '90-min Comprehensive', INR: 8000,  USD: 96,  durationMin: 90  },
};

function getPrice(tier, currency) {
  const t = PRICES[tier];
  if (!t) return null;
  return { ...t, amount: t[currency], currency };
}

// ── Validation helpers ─────────────────────────────────────────────────────────
function isValidDate(d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T00:00:00').getTime()); }
function isValidTime(t) { return /^\d{2}:\d{2}$/.test(t); }

function validateBookingBody(body) {
  const { tier, date, time_start, time_end, health_concerns } = body;
  if (!PRICES[tier])          return 'Invalid consultation tier';
  if (!isValidDate(date))     return 'Invalid date (YYYY-MM-DD)';
  if (!isValidTime(time_start) || !isValidTime(time_end)) return 'Invalid time (HH:MM)';
  if (!health_concerns?.trim()) return 'Health concerns are required';
  return null;
}

// ── Internal: book appointment after payment confirmed ─────────────────────────
async function bookAfterPayment({ userId, tier, date, time_start, time_end,
  health_concerns, medical_history, goals,
  paymentId, paymentOrderId, paymentGateway, currency }) {

  const t = PRICES[tier];
  const cleanConcerns = sanitize(health_concerns.trim());
  const cleanHistory  = sanitize((medical_history || '').trim());
  const cleanGoals    = sanitize((goals || '').trim());

  const appointment = await prisma.$transaction(async (tx) => {
    const conflict = await tx.appointment.findFirst({
      where: { date, timeStart: time_start, status: 'confirmed' }
    });
    if (conflict) {
      const e = new Error('SLOT_TAKEN');
      e.code  = 'SLOT_TAKEN';
      throw e;
    }
    return tx.appointment.create({
      data: {
        userId,
        date,
        timeStart:         time_start,
        timeEnd:           time_end,
        consultationType:  tier,
        consultationPrice: t.INR,    // store canonical INR price
        healthConcerns:    cleanConcerns,
        medicalHistory:    cleanHistory || null,
        goals:             cleanGoals  || null,
        paymentStatus:     'paid',
        paymentId,
        paymentOrderId,
        paymentGateway,
        currency,
      }
    });
  }, { isolationLevel: 'Serializable' });

  return appointment;
}

// ── Client config (served as JS) ──────────────────────────────────────────────
// GET /api/payments/config.js  — injects window.__PAYMENT_TEST_MODE__
router.get('/config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`window.__PAYMENT_TEST_MODE__ = ${TEST_MODE};`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEST MODE — simulate payment, book immediately, no gateway needed
// POST /api/payments/test/complete
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/test/complete', authenticate, async (req, res) => {
  if (!TEST_MODE) return res.status(403).json({ error: 'Test mode not enabled' });

  const err = validateBookingBody(req.body);
  if (err) return res.status(400).json({ error: err });

  const { tier, date, time_start, time_end, health_concerns, medical_history, goals } = req.body;
  const currency = req.body.currency || 'INR';

  try {
    const fakeOrderId = `test_order_${Date.now()}`;
    const fakePayId   = `test_pay_${Date.now()}`;

    const appointment = await bookAfterPayment({
      userId: req.user.id,
      tier, date, time_start, time_end, health_concerns, medical_history, goals,
      paymentId:      fakePayId,
      paymentOrderId: fakeOrderId,
      paymentGateway: 'test',
      currency,
    });

    // Google Calendar (non-critical)
    try {
      const eventId = await createCalendarEvent(
        {
          id:                 appointment.id,
          date,
          time_start,
          time_end,
          consultation_type:  tier.key || tier,
          consultation_price: tier.price,
          health_concerns:    sanitize(health_concerns.trim()),
          medical_history:    sanitize((medical_history||'').trim()),
          goals:              sanitize((goals||'').trim()),
          status:             'confirmed',
        },
        req.user
      );
      if (eventId) await prisma.appointment.update({ where: { id: appointment.id }, data: { googleEventId: eventId } });
    } catch {}

    // WhatsApp (fire-and-forget)
    const apptData = { date, time_start, time_end,
      health_concerns: sanitize(health_concerns.trim()),
      goals: sanitize((goals||'').trim()),
      medical_history: sanitize((medical_history||'').trim()) };
    wa.sendBookingConfirmation(req.user.phone, req.user.name, apptData).catch(() => {});
    wa.sendAdminNewBooking(apptData, req.user).catch(() => {});

    res.json({
      success: true,
      test_mode: true,
      message: 'Test payment accepted — appointment booked!',
      appointment: { id: appointment.id, date, time_start, time_end, status: 'confirmed' },
    });
  } catch (e) {
    if (e.code === 'SLOT_TAKEN' || e.code === 'P2002' || e.code === 'P2034') {
      return res.status(409).json({ error: 'Time slot already taken. Choose another.' });
    }
    console.error('[Test payment] error:', e);
    res.status(500).json({ error: 'Test booking failed.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RAZORPAY — CREATE ORDER
// POST /api/payments/razorpay/create-order
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/razorpay/create-order', authenticate, async (req, res) => {
  const { tier } = req.body;
  const err = validateBookingBody(req.body);
  if (err) return res.status(400).json({ error: err });

  const price = getPrice(tier, 'INR');
  if (!price) return res.status(400).json({ error: 'Invalid tier' });

  try {
    const { getRazorpay } = require('../lib/razorpay');
    const rzp = getRazorpay();

    const order = await rzp.orders.create({
      amount:   price.amount * 100,   // paise
      currency: 'INR',
      receipt:  `tac_${req.user.id}_${Date.now()}`,
      notes: {
        user_id:    String(req.user.id),
        tier,
        patient:    req.user.name,
        email:      req.user.email,
      },
    });

    res.json({
      order_id: order.id,
      amount:   order.amount,
      currency: order.currency,
      key_id:   process.env.RAZORPAY_KEY_ID,
      tier_label: price.label,
    });
  } catch (e) {
    console.error('[Razorpay] create-order error:', e.message);
    res.status(500).json({ error: 'Could not initialise payment. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RAZORPAY — VERIFY + BOOK
// POST /api/payments/razorpay/verify
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/razorpay/verify', authenticate, async (req, res) => {
  const {
    razorpay_payment_id, razorpay_order_id, razorpay_signature,
    tier, date, time_start, time_end, health_concerns, medical_history, goals,
  } = req.body;

  // 1. Verify HMAC signature
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields' });
  }

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature))) {
    return res.status(400).json({ error: 'Payment signature verification failed' });
  }

  // 2. Validate booking fields
  const err = validateBookingBody({ tier, date, time_start, time_end, health_concerns });
  if (err) return res.status(400).json({ error: err });

  // 3. Book appointment
  try {
    const appointment = await bookAfterPayment({
      userId:        req.user.id,
      tier, date, time_start, time_end, health_concerns, medical_history, goals,
      paymentId:     razorpay_payment_id,
      paymentOrderId: razorpay_order_id,
      paymentGateway: 'razorpay',
      currency:      'INR',
    });

    // Google Calendar (non-critical)
    try {
      const eventId = await createCalendarEvent(
        {
          id:                 appointment.id,
          date,
          time_start,
          time_end,
          consultation_type:  tier.key || tier,
          consultation_price: tier.price,
          health_concerns:    sanitize(health_concerns.trim()),
          medical_history:    sanitize((medical_history||'').trim()),
          goals:              sanitize((goals||'').trim()),
          status:             'confirmed',
        },
        req.user
      );
      if (eventId) await prisma.appointment.update({ where: { id: appointment.id }, data: { googleEventId: eventId } });
    } catch {}

    // WhatsApp (fire-and-forget)
    const apptData = { date, time_start, time_end,
      health_concerns: sanitize(health_concerns.trim()),
      goals: sanitize((goals||'').trim()),
      medical_history: sanitize((medical_history||'').trim()) };
    wa.sendBookingConfirmation(req.user.phone, req.user.name, apptData).catch(e => console.error('[WhatsApp] booking confirmation failed:', e.message));
    wa.sendAdminNewBooking(apptData, req.user).catch(e => console.error('[WhatsApp] admin booking alert failed:', e.message));

    res.json({
      success: true,
      message: 'Payment confirmed and appointment booked!',
      appointment: { id: appointment.id, date, time_start, time_end, status: 'confirmed' }
    });
  } catch (e) {
    if (e.code === 'SLOT_TAKEN' || e.code === 'P2002' || e.code === 'P2034') {
      return res.status(409).json({ error: 'This time slot was just booked by someone else. Please choose another.' });
    }
    console.error('[Razorpay] verify/book error:', e);
    res.status(500).json({ error: 'Payment verified but booking failed. Contact support with your payment ID: ' + razorpay_payment_id });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STRIPE — CREATE CHECKOUT SESSION
// POST /api/payments/stripe/create-session
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/stripe/create-session', authenticate, async (req, res) => {
  // Stripe keys not yet configured — fall back to test mode booking
  if (!STRIPE_READY) {
    req.body.currency = 'USD';
    const err2 = validateBookingBody(req.body);
    if (err2) return res.status(400).json({ error: err2 });
    const { tier, date, time_start, time_end, health_concerns, medical_history, goals } = req.body;
    try {
      const appointment = await bookAfterPayment({
        userId: req.user.id,
        tier, date, time_start, time_end, health_concerns, medical_history, goals,
        paymentId: `test_stripe_${Date.now()}`,
        paymentOrderId: `test_session_${Date.now()}`,
        paymentGateway: 'test_stripe',
        currency: 'USD',
      });
      const apptData = { date, time_start, time_end,
        health_concerns: sanitize(health_concerns.trim()),
        goals: sanitize((goals||'').trim()),
        medical_history: sanitize((medical_history||'').trim()) };
      wa.sendBookingConfirmation(req.user.phone, req.user.name, apptData).catch(() => {});
      wa.sendAdminNewBooking(apptData, req.user).catch(() => {});
      return res.json({ test_mode: true, success: true, appointment: { id: appointment.id, date, time_start, time_end } });
    } catch (e) {
      if (e.code === 'SLOT_TAKEN' || e.code === 'P2002' || e.code === 'P2034')
        return res.status(409).json({ error: 'Time slot already taken.' });
      return res.status(500).json({ error: 'Booking failed.' });
    }
  }

  const { tier, date, time_start, time_end, health_concerns, medical_history, goals } = req.body;
  const err = validateBookingBody(req.body);
  if (err) return res.status(400).json({ error: err });

  const price = getPrice(tier, 'USD');
  if (!price) return res.status(400).json({ error: 'Invalid tier' });

  try {
    const { getStripe } = require('../lib/stripe');
    const stripe = getStripe();

    const baseUrl = process.env.APP_URL || 'https://theanirudhcode.com';

    const session = await stripe.checkout.sessions.create({
      mode:           'payment',
      currency:       'usd',
      line_items: [{
        price_data: {
          currency:     'usd',
          unit_amount:  price.amount * 100,   // cents
          product_data: {
            name:        `theanirudhcode — ${price.label}`,
            description: `${price.durationMin}-minute consultation with Dr. Anirudh · ${date} at ${time_start}`,
          },
        },
        quantity: 1,
      }],
      customer_email: req.user.email,
      success_url: `${baseUrl}/my-appointments?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/?payment=cancelled`,
      metadata: {
        user_id:        String(req.user.id),
        user_name:      req.user.name,
        user_email:     req.user.email,
        user_phone:     req.user.phone || '',
        tier,
        date,
        time_start,
        time_end,
        health_concerns: (health_concerns || '').slice(0, 500),
        medical_history: (medical_history || '').slice(0, 500),
        goals:           (goals || '').slice(0, 500),
      },
      payment_intent_data: {
        description: `theanirudhcode — ${price.label} — ${req.user.name}`,
      },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('[Stripe] create-session error:', e.message);
    res.status(500).json({ error: 'Could not initialise payment. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK  (raw body — mounted before express.json in server.js)
// POST /api/payments/stripe/webhook
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/stripe/webhook', async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('[Stripe webhook] STRIPE_WEBHOOK_SECRET not set');
    return res.status(500).end();
  }

  let event;
  try {
    const { getStripe } = require('../lib/stripe');
    event = getStripe().webhooks.constructEvent(req.body, sig, secret);
  } catch (e) {
    console.error('[Stripe webhook] signature verification failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status !== 'paid') return res.json({ received: true });

    const m = session.metadata;
    const userId = parseInt(m.user_id, 10);

    // Guard: don't double-book if webhook fires twice
    const existing = await prisma.appointment.findFirst({
      where: { paymentOrderId: session.id }
    });
    if (existing) return res.json({ received: true });

    try {
      const appointment = await bookAfterPayment({
        userId,
        tier:           m.tier,
        date:           m.date,
        time_start:     m.time_start,
        time_end:       m.time_end,
        health_concerns: m.health_concerns,
        medical_history: m.medical_history,
        goals:           m.goals,
        paymentId:       session.payment_intent,
        paymentOrderId:  session.id,
        paymentGateway:  'stripe',
        currency:        'USD',
      });

      // Google Calendar (non-critical)
      try {
        const fakeUser = { id: userId, name: m.user_name, email: m.user_email, phone: m.user_phone };
        const tierObj  = m.tier && typeof m.tier === 'object' ? m.tier : {};
        const eventId  = await createCalendarEvent(
          {
            id:                 appointment.id,
            date:               m.date,
            time_start:         m.time_start,
            time_end:           m.time_end,
            consultation_type:  tierObj.key || m.tier,
            consultation_price: tierObj.price,
            health_concerns:    sanitize(m.health_concerns),
            medical_history:    sanitize(m.medical_history),
            goals:              sanitize(m.goals),
            status:             'confirmed',
          },
          fakeUser
        );
        if (eventId) await prisma.appointment.update({ where: { id: appointment.id }, data: { googleEventId: eventId } });
      } catch {}

      // WhatsApp (fire-and-forget)
      if (m.user_phone) {
        const apptData = { date: m.date, time_start: m.time_start, time_end: m.time_end,
          health_concerns: sanitize(m.health_concerns),
          goals: sanitize(m.goals),
          medical_history: sanitize(m.medical_history) };
        wa.sendBookingConfirmation(m.user_phone, m.user_name, apptData).catch(() => {});
        wa.sendAdminNewBooking(apptData, { name: m.user_name, email: m.user_email, phone: m.user_phone }).catch(() => {});
      }

      console.log(`[Stripe webhook] Appointment booked: #${appointment.id} for user ${userId}`);
    } catch (e) {
      if (e.code === 'SLOT_TAKEN') {
        console.warn(`[Stripe webhook] Slot taken for session ${session.id} — user should be contacted manually`);
      } else {
        console.error('[Stripe webhook] booking error:', e);
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
