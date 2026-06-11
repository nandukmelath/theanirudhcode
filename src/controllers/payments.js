/**
 * Payment controller — Razorpay (INR/India) + Stripe (USD/International)
 *
 * TEST MODE: set PAYMENT_TEST_MODE=true in env to bypass real gateways.
 * Everything works end-to-end. Flip off when real keys are added.
 *
 * Routes:
 *   POST /api/payments/cashfree/create-order
 *   POST /api/payments/cashfree/verify
 *   POST /api/payments/cashfree/webhook
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
const CASHFREE_READY   = !!(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY);
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
  const tzOffset = process.env.PRACTITIONER_TZ_OFFSET || '+05:30';
  if (new Date(`${date}T23:59:59${tzOffset}`) < new Date()) return 'Cannot book appointments in the past.';
  if (!isValidTime(time_start) || !isValidTime(time_end)) return 'Invalid time (HH:MM)';
  if (time_end <= time_start) return 'End time must be after start time.';
  if (!health_concerns?.trim()) return 'Health concerns are required';
  return null;
}

// ── Internal: book appointment after payment confirmed ─────────────────────────
async function bookAfterPayment({ userId, tier, date, time_start, time_end,
  health_concerns, medical_history, goals, patientAge, consent,
  paymentId, paymentOrderId, paymentGateway, currency }) {

  const t = PRICES[tier];
  const cleanConcerns = sanitize(health_concerns.trim());
  const cleanHistory  = sanitize((medical_history || '').trim());
  const cleanGoals    = sanitize((goals || '').trim());

  // TPG-2020: explicit telemedicine consent is mandatory; age required before prescribing
  if (consent !== true) {
    const e = new Error('CONSENT_REQUIRED');
    e.code = 'CONSENT_REQUIRED';
    throw e;
  }
  const age = parseInt(patientAge, 10);
  const cleanAge = Number.isInteger(age) && age >= 1 && age <= 120 ? age : null;

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
        patientAge:        cleanAge,
        consentAt:         new Date(),   // explicit consent recorded (TPG-2020)
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

  const { tier, date, time_start, time_end, health_concerns, medical_history, goals, age, consent } = req.body;
  const currency = req.body.currency || 'INR';

  try {
    const fakeOrderId = `test_order_${Date.now()}`;
    const fakePayId   = `test_pay_${Date.now()}`;

    const appointment = await bookAfterPayment({
      userId: req.user.id,
      tier, date, time_start, time_end, health_concerns, medical_history, goals,
      patientAge: age, consent: consent === true,
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
    if (e.code === 'CONSENT_REQUIRED') {
      return res.status(400).json({ error: 'Telemedicine consent is required to book a consultation.' });
    }
    console.error('[Test payment] error:', e);
    res.status(500).json({ error: 'Test booking failed.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CASHFREE — CREATE ORDER
// POST /api/payments/cashfree/create-order
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/cashfree/create-order', authenticate, async (req, res) => {
  const err = validateBookingBody(req.body);
  if (err) return res.status(400).json({ error: err });

  const { tier, consent } = req.body;

  // TPG-2020: fail fast — no payment without explicit telemedicine consent
  if (consent !== true) return res.status(400).json({ error: 'Please accept the telemedicine consent to continue.' });

  if (!CASHFREE_READY) {
    return res.status(503).json({ error: 'Online payments not yet configured. Please try again later.' });
  }

  const price = getPrice(tier, 'INR');
  if (!price) return res.status(400).json({ error: 'Invalid tier' });

  const orderId  = `tac_${req.user.id}_${Date.now()}`;
  const rawDigits = (req.user.phone || '').replace(/\D/g, '');
  const phone10   = rawDigits.length >= 10 ? rawDigits.slice(-10) : '9999999999';
  const appUrl   = process.env.APP_URL || 'https://theanirudhcode.com';
  const cfEnv    = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';

  try {
    const { createOrder } = require('../lib/cashfree');
    const order = await createOrder({
      order_id:       orderId,
      order_amount:   price.amount,
      order_currency: 'INR',
      customer_details: {
        customer_id:    String(req.user.id),
        customer_name:  req.user.name,
        customer_email: req.user.email,
        customer_phone: phone10,
      },
      order_meta: {
        return_url:  `${appUrl}/my-appointments?payment=done&order_id=${orderId}`,
        notify_url:  `${appUrl}/api/payments/cashfree/webhook`,
      },
      order_note: `${price.label} · ${req.body.date} ${req.body.time_start}`,
    });

    res.json({
      order_id:           orderId,
      payment_session_id: order.payment_session_id,
      amount:             price.amount,
      currency:           'INR',
      tier_label:         price.label,
      env:                cfEnv,
    });
  } catch (e) {
    console.error('[Cashfree] create-order error:', e.message);
    res.status(500).json({ error: 'Could not initialise payment. Please try again.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CASHFREE — VERIFY + BOOK
// POST /api/payments/cashfree/verify
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/cashfree/verify', authenticate, async (req, res) => {
  const {
    order_id,
    tier, date, time_start, time_end, health_concerns, medical_history, goals,
    age, consent,
  } = req.body;

  if (!order_id) return res.status(400).json({ error: 'Missing order_id' });

  const err = validateBookingBody({ tier, date, time_start, time_end, health_concerns });
  if (err) return res.status(400).json({ error: err });

  // Idempotency: return existing appointment if this order was already booked
  const existing = await prisma.appointment.findFirst({ where: { paymentOrderId: order_id } });
  if (existing) {
    return res.json({
      success: true,
      message: 'Appointment already confirmed!',
      appointment: { id: existing.id, date: existing.date, timeStart: existing.timeStart, timeEnd: existing.timeEnd, status: existing.status },
    });
  }

  try {
    const { getOrder, getOrderPayments } = require('../lib/cashfree');
    const cfOrder = await getOrder(order_id);

    if (cfOrder.order_status !== 'PAID') {
      return res.status(400).json({ error: `Payment not completed (status: ${cfOrder.order_status}). Please try again.` });
    }

    // Best-effort: get the actual Cashfree payment ID for audit trail
    let paymentId = String(cfOrder.cf_order_id || order_id);
    try {
      const payments = await getOrderPayments(order_id);
      if (Array.isArray(payments) && payments[0]?.cf_payment_id) {
        paymentId = String(payments[0].cf_payment_id);
      }
    } catch {}

    const appointment = await bookAfterPayment({
      userId:         req.user.id,
      tier, date, time_start, time_end, health_concerns, medical_history, goals,
      patientAge:     age, consent: consent === true,
      paymentId,
      paymentOrderId: order_id,
      paymentGateway: 'cashfree',
      currency:       'INR',
    });

    // Google Calendar (non-critical)
    try {
      const eventId = await createCalendarEvent(
        {
          id:                 appointment.id,
          date, time_start, time_end,
          consultation_type:  tier,
          consultation_price: getPrice(tier, 'INR')?.amount,
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
      goals:           sanitize((goals||'').trim()),
      medical_history: sanitize((medical_history||'').trim()) };
    wa.sendBookingConfirmation(req.user.phone, req.user.name, apptData).catch(e => console.error('[WhatsApp] booking confirmation failed:', e.message));
    wa.sendAdminNewBooking(apptData, req.user).catch(e => console.error('[WhatsApp] admin booking alert failed:', e.message));

    res.json({
      success: true,
      message: 'Payment confirmed and appointment booked!',
      appointment: { id: appointment.id, date, time_start, time_end, status: 'confirmed' },
    });
  } catch (e) {
    if (e.code === 'SLOT_TAKEN' || e.code === 'P2002' || e.code === 'P2034') {
      return res.status(409).json({ error: 'This time slot was just booked by someone else. Please choose another.' });
    }
    if (e.code === 'CONSENT_REQUIRED') {
      return res.status(400).json({ error: 'Telemedicine consent is required to book a consultation.' });
    }
    console.error('[Cashfree] verify/book error:', e);
    res.status(500).json({ error: `Payment verified but booking failed. Contact support with order ID: ${order_id}` });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CASHFREE — WEBHOOK  (raw body — mounted before express.json in server.js)
// POST /api/payments/cashfree/webhook
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/cashfree/webhook', async (req, res) => {
  const signature = req.headers['x-webhook-signature'];
  const timestamp = req.headers['x-webhook-timestamp'];
  const secret    = process.env.CASHFREE_SECRET_KEY;

  if (!signature || !timestamp) {
    console.error('[Cashfree webhook] missing signature / timestamp headers');
    return res.status(400).end();
  }
  if (!secret) {
    // Our config issue, not a bad request — return 200 to prevent Cashfree retry loops
    console.error('[Cashfree webhook] CASHFREE_SECRET_KEY not configured');
    return res.json({ received: true });
  }

  // Cashfree signature: base64(HMAC-SHA256(timestamp + rawBody, secretKey))
  const rawBody = req.body.toString('utf8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(timestamp + rawBody)
    .digest('base64');

  if (signature !== expected) {
    console.error('[Cashfree webhook] signature mismatch');
    return res.status(400).end();
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return res.status(400).end(); }

  // PAYMENT_SUCCESS_WEBHOOK is the primary event; booking is handled by /cashfree/verify.
  // Webhook logs the event for audit and handles edge cases (client never called verify).
  if (event.type === 'PAYMENT_SUCCESS_WEBHOOK') {
    const orderId = event.data?.order?.order_id;
    console.log(`[Cashfree webhook] PAYMENT_SUCCESS for order ${orderId}`);

    if (orderId) {
      // fp_ orders are Fasting Program enrollments; everything else is an appointment
      const isFasting = orderId.startsWith('fp_');
      const existing = isFasting
        ? await prisma.cohortEnrollment.findFirst({ where: { paymentOrderId: orderId } })
        : await prisma.appointment.findFirst({ where: { paymentOrderId: orderId } });
      if (existing) {
        console.log(`[Cashfree webhook] ${isFasting ? 'enrollment' : 'appointment'} ${existing.id} already recorded — no action needed`);
      } else {
        // Booking data not available in webhook — client verify is the primary path.
        // If verify was never called (e.g. browser crash after redirect), admin must confirm manually.
        console.warn(`[Cashfree webhook] order ${orderId} PAID but no ${isFasting ? 'enrollment' : 'appointment'} found — needs manual review`);
      }
    }
  }

  res.json({ received: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FASTING PROGRAM — 3-Day Guided Water Fast (₹1,999)
// POST /api/payments/fasting/create-order   POST /api/payments/fasting/verify
// Enrollments stored in cohort_enrollments under a rolling cohort row.
// ═══════════════════════════════════════════════════════════════════════════════
const FASTING = { key: 'water-fast-3day', label: '3-Day Guided Water Fast', INR: 1999 };
// Water fasting is contraindicated for these — hard-block, route to consultation
const FASTING_BLOCKED    = ['pregnant', 'eating_disorder', 'type1_diabetes'];
const FASTING_CONDITIONS = ['none', 'diabetes_meds', 'bp_meds', 'kidney_liver', 'heart', 'pregnant', 'eating_disorder', 'type1_diabetes', 'other'];
const FASTING_EXPERIENCE = ['none', 'intermittent', 'extended'];

function validateFastingBody(body) {
  const age = parseInt(body.age, 10);
  if (!Number.isInteger(age) || age < 18 || age > 75) return 'Age must be between 18 and 75 for a supervised water fast.';
  const wa = String(body.whatsapp || '').replace(/\D/g, '');
  if (wa.length < 10) return 'A valid WhatsApp number is required — the support community lives there.';
  if (!FASTING_EXPERIENCE.includes(body.experience)) return 'Select your fasting experience.';
  if (!body.goal || !String(body.goal).trim()) return 'Tell us your primary goal for the fast.';
  if (!Array.isArray(body.conditions) || !body.conditions.every(c => FASTING_CONDITIONS.includes(c))) return 'Invalid medical screening data.';
  if (body.consent !== true) return 'Please accept the telemedicine consent to continue.';
  return null;
}

function sanitizeFastingIntake(body) {
  return {
    age:         parseInt(body.age, 10),
    sex:         ['male', 'female', 'other'].includes(body.sex) ? body.sex : null,
    whatsapp:    String(body.whatsapp || '').replace(/\D/g, '').slice(-12),
    city:        sanitize(String(body.city || '').trim()).slice(0, 80) || null,
    experience:  body.experience,
    goal:        sanitize(String(body.goal || '').trim()).slice(0, 500),
    conditions:  (body.conditions || []).filter(c => FASTING_CONDITIONS.includes(c)),
    medications: sanitize(String(body.medications || '').trim()).slice(0, 500) || null,
    consent_at:  new Date().toISOString(),   // TPG-2020 explicit consent
  };
}

async function getOrCreateFastingCohort() {
  let cohort = await prisma.cohort.findFirst({ where: { name: FASTING.label, isActive: true } });
  if (!cohort) {
    cohort = await prisma.cohort.create({
      data: {
        name: FASTING.label,
        tagline: 'Reset your metabolism in 72 hours',
        description: '3-day doctor-guided water fast — daily live sessions, WhatsApp community, prep and refeed protocols.',
        startDate: 'rolling',
        durationWeeks: 1,
        price: FASTING.INR,
        maxParticipants: 100000,
        spotsLeft: 100000,
      },
    });
  }
  return cohort;
}

async function enrollFasting({ user, orderId, paymentId, gateway, intake }) {
  const cohort = await getOrCreateFastingCohort();
  return prisma.cohortEnrollment.create({
    data: {
      cohortId:       cohort.id,
      userId:         user.id,
      name:           user.name,
      email:          user.email,
      phone:          intake.whatsapp || user.phone || null,
      message:        intake.goal || null,
      program:        FASTING.key,
      intake,
      status:         'enrolled',
      paymentStatus:  'paid',
      paymentId,
      paymentOrderId: orderId,
      paymentGateway: gateway,
      currency:       'INR',
      amountPaid:     FASTING.INR,
    },
  });
}

// Welcome (user) + intake summary (doctor) on WhatsApp — fire-and-forget
async function notifyFastingEnrollment(user, intake) {
  const group = process.env.WHATSAPP_GROUP_INVITE || '';
  const first = (user.name || '').split(' ')[0] || 'there';
  const userMsg =
    `🌿 *theanirudhcode — You're enrolled!*\n\n*${FASTING.label}*\n\n` +
    `Welcome, ${first}. Your 72-hour reset begins soon.\n\n` +
    `✅ Daily live sessions with Dr. Anirudh\n` +
    `✅ Doctor-monitored WhatsApp community\n` +
    `✅ Pre-fast prep + electrolyte protocol\n` +
    `✅ Structured refeed plan` +
    (group ? `\n\n👉 Join your support group now:\n${group}` : `\n\nYour support-group invite arrives on WhatsApp shortly.`);
  const adminMsg =
    `🔔 *New Fasting Program enrollment*\n\n` +
    `${user.name} (${user.email})\n` +
    `WhatsApp: ${intake.whatsapp}\nAge ${intake.age}${intake.sex ? ' · ' + intake.sex : ''}${intake.city ? ' · ' + intake.city : ''}\n` +
    `Experience: ${intake.experience}\nGoal: ${intake.goal}\n` +
    `Conditions: ${(intake.conditions || []).filter(c => c !== 'none').join(', ') || 'none'}\n` +
    `Meds: ${intake.medications || '—'}\n` +
    `Paid ₹${FASTING.INR.toLocaleString('en-IN')}`;
  await Promise.allSettled([
    wa.sendText(intake.whatsapp || user.phone, userMsg),
    process.env.DOCTOR_WHATSAPP ? wa.sendText(process.env.DOCTOR_WHATSAPP, adminMsg) : Promise.resolve(),
  ]);
}

router.post('/fasting/create-order', authenticate, async (req, res) => {
  const err = validateFastingBody(req.body);
  if (err) return res.status(400).json({ error: err });

  // Safety gate: contraindicated profiles never reach payment
  const blocked = (req.body.conditions || []).filter(c => FASTING_BLOCKED.includes(c));
  if (blocked.length) {
    return res.status(422).json({
      blocked: true,
      error: "For your safety, an unsupervised 3-day water fast isn't recommended with your profile. Book a consultation instead — Dr. Anirudh will design a protocol that fits your biology.",
    });
  }

  const intake = sanitizeFastingIntake(req.body);

  // Test mode — enroll immediately, no gateway
  if (TEST_MODE) {
    try {
      const enrollment = await enrollFasting({
        user: req.user,
        orderId: `fp_test_${Date.now()}`,
        paymentId: `fp_pay_test_${Date.now()}`,
        gateway: 'test',
        intake,
      });
      notifyFastingEnrollment(req.user, intake).catch(() => {});
      return res.json({
        test_mode: true, success: true,
        message: 'Test enrollment accepted — you are in!',
        enrollment_id: enrollment.id,
        whatsapp_group: process.env.WHATSAPP_GROUP_INVITE || '',
      });
    } catch (e) {
      console.error('[Fasting test] enroll error:', e);
      return res.status(500).json({ error: 'Enrollment failed. Please try again.' });
    }
  }

  if (!CASHFREE_READY) {
    return res.status(503).json({ error: 'Online payments not yet configured. Please try again later.' });
  }

  const orderId   = `fp_${req.user.id}_${Date.now()}`;
  const rawDigits = (intake.whatsapp || req.user.phone || '').replace(/\D/g, '');
  const phone10   = rawDigits.length >= 10 ? rawDigits.slice(-10) : '9999999999';
  const appUrl    = process.env.APP_URL || 'https://theanirudhcode.com';
  const cfEnv     = process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox';

  try {
    const { createOrder } = require('../lib/cashfree');
    const order = await createOrder({
      order_id:       orderId,
      order_amount:   FASTING.INR,
      order_currency: 'INR',
      customer_details: {
        customer_id:    String(req.user.id),
        customer_name:  req.user.name,
        customer_email: req.user.email,
        customer_phone: phone10,
      },
      order_meta: {
        return_url: `${appUrl}/my-appointments?payment=done&order_id=${orderId}`,
        notify_url: `${appUrl}/api/payments/cashfree/webhook`,
      },
      order_note: FASTING.label,
    });

    res.json({
      order_id:           orderId,
      payment_session_id: order.payment_session_id,
      amount:             FASTING.INR,
      currency:           'INR',
      tier_label:         FASTING.label,
      env:                cfEnv,
    });
  } catch (e) {
    console.error('[Fasting] create-order error:', e.message);
    res.status(500).json({ error: 'Could not initialise payment. Please try again.' });
  }
});

router.post('/fasting/verify', authenticate, async (req, res) => {
  const { order_id } = req.body;
  if (!order_id || !order_id.startsWith('fp_')) return res.status(400).json({ error: 'Missing order_id' });

  const err = validateFastingBody(req.body);
  if (err) return res.status(400).json({ error: err });

  // Idempotency — refresh/double-call returns the existing enrollment
  const existing = await prisma.cohortEnrollment.findFirst({ where: { paymentOrderId: order_id } });
  if (existing) {
    return res.json({ success: true, message: 'You are already enrolled!', whatsapp_group: process.env.WHATSAPP_GROUP_INVITE || '' });
  }

  try {
    const { getOrder, getOrderPayments } = require('../lib/cashfree');
    const cfOrder = await getOrder(order_id);

    if (cfOrder.order_status !== 'PAID') {
      return res.status(400).json({ error: `Payment not completed (status: ${cfOrder.order_status}). Please try again.` });
    }

    let paymentId = String(cfOrder.cf_order_id || order_id);
    try {
      const payments = await getOrderPayments(order_id);
      if (Array.isArray(payments) && payments[0]?.cf_payment_id) paymentId = String(payments[0].cf_payment_id);
    } catch {}

    const intake = sanitizeFastingIntake(req.body);
    await enrollFasting({ user: req.user, orderId: order_id, paymentId, gateway: 'cashfree', intake });
    notifyFastingEnrollment(req.user, intake).catch(() => {});

    res.json({
      success: true,
      message: 'Payment confirmed — you are enrolled!',
      whatsapp_group: process.env.WHATSAPP_GROUP_INVITE || '',
    });
  } catch (e) {
    console.error('[Fasting] verify/enroll error:', e);
    res.status(500).json({ error: `Payment verified but enrollment failed. Contact support with order ID: ${order_id}` });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STRIPE — CREATE CHECKOUT SESSION
// POST /api/payments/stripe/create-session
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/stripe/create-session', authenticate, async (req, res) => {
  // Stripe keys not yet configured
  if (!STRIPE_READY) {
    // Only allow fallback booking in explicit test mode
    if (!TEST_MODE) {
      return res.status(503).json({ error: 'International payments are not yet available. Please use the INR payment option.' });
    }
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

    if (!userId || userId < 1) {
      console.error(`[Stripe webhook] Invalid user_id in metadata for session ${session.id}`);
      return res.json({ received: true });
    }
    if (!PRICES[m.tier]) {
      console.error(`[Stripe webhook] Invalid tier "${m.tier}" in metadata for session ${session.id}`);
      return res.json({ received: true });
    }
    if (!m.date || !m.time_start || !m.time_end || !m.health_concerns) {
      console.error(`[Stripe webhook] Missing required booking fields in metadata for session ${session.id}`);
      return res.json({ received: true });
    }

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
