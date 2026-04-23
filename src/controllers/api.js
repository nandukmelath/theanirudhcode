const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { validateEmail, sanitize } = require('../middleware/validate');
const wa = require('../lib/whatsapp');

// POST /api/subscribe
router.post('/subscribe', async (req, res) => {
  const { name, email, source } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });

  const cleanName = sanitize(name.trim());
  const cleanEmail = email.trim().toLowerCase();
  const cleanSource = sanitize(source || 'free-guide');

  try {
    const existing = await prisma.subscriber.findUnique({ where: { email: cleanEmail } });
    if (existing) {
      return res.status(409).json({ error: 'This email is already subscribed', alreadySubscribed: true });
    }

    await prisma.subscriber.create({
      data: { name: cleanName, email: cleanEmail, source: cleanSource }
    });

    res.status(201).json({
      success: true,
      message: 'Welcome to the healing journey! Check your email for the guide.'
    });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/consultation
router.post('/consultation', async (req, res) => {
  const { name, email, phone, preferred_date, message } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });

  try {
    await prisma.consultation.create({
      data: {
        name: sanitize(name.trim()),
        email: email.trim().toLowerCase(),
        phone: sanitize((phone || '').trim()) || null,
        preferredDate: preferred_date || null,
        message: sanitize((message || '').trim()) || null,
      }
    });

    res.status(201).json({
      success: true,
      message: 'Your consultation request has been received. We will reach out within 24 hours.'
    });

    // Notify admin via WhatsApp (non-blocking, after response sent)
    const consult = { name: sanitize(name.trim()), email: email.trim().toLowerCase(), phone: sanitize((phone || '').trim()) || null, message: sanitize((message || '').trim()) || null };
    wa.sendAdminConsultationAlert(consult).catch(() => {});
  } catch (err) {
    console.error('Consultation error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/posts
router.get('/posts', async (req, res) => {
  try {
    const { category } = req.query;
    const where = { published: true };
    if (category) where.category = category;

    const posts = await prisma.post.findMany({
      where,
      select: { id: true, title: true, slug: true, category: true, tags: true, excerpt: true, canvasType: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ posts });
  } catch (err) {
    console.error('Posts list error:', err);
    res.status(500).json({ error: 'Failed to load posts' });
  }
});

// GET /api/posts/:slug
router.get('/posts/:slug', async (req, res) => {
  try {
    const post = await prisma.post.findUnique({ where: { slug: req.params.slug } });
    if (!post || !post.published) return res.status(404).json({ error: 'Post not found' });
    res.json({ post });
  } catch (err) {
    console.error('Post detail error:', err);
    res.status(500).json({ error: 'Failed to load post' });
  }
});

// GET /api/products
router.get('/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { available: true },
      orderBy: { price: 'asc' },
    });
    res.json({ products });
  } catch (err) {
    console.error('Products error:', err);
    res.status(500).json({ error: 'Failed to load products' });
  }
});

// POST /api/products/:id/order
router.post('/products/:id/order', async (req, res) => {
  const productId = parseInt(req.params.id, 10);
  if (!productId || productId < 1) return res.status(400).json({ error: 'Invalid product' });

  const { name, email, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Valid email is required' });

  try {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || !product.available) return res.status(404).json({ error: 'Product not found' });

    await prisma.productOrder.create({
      data: {
        productId,
        name:  sanitize(name.trim()),
        email: email.trim().toLowerCase(),
        phone: sanitize((phone || '').trim()) || null,
      }
    });

    wa.sendAdminConsultationAlert({
      name: sanitize(name.trim()),
      email: email.trim().toLowerCase(),
      phone: sanitize((phone || '').trim()) || null,
      message: `Product order: "${product.title}" — ₹${product.price}`,
    }).catch(() => {});

    res.status(201).json({ success: true, message: `Order received! We will reach out within 24 hours with payment details for "${product.title}".` });
  } catch (err) {
    console.error('Product order error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/cohorts
router.get('/cohorts', async (req, res) => {
  try {
    const cohorts = await prisma.cohort.findMany({
      where: { isActive: true },
      orderBy: { startDate: 'asc' },
    });
    res.json({ cohorts });
  } catch (err) {
    console.error('Cohorts error:', err);
    res.status(500).json({ error: 'Failed to load cohorts' });
  }
});

// POST /api/cohorts/:id/enroll
router.post('/cohorts/:id/enroll', async (req, res) => {
  const cohortId = parseInt(req.params.id, 10);
  if (!cohortId || cohortId < 1) return res.status(400).json({ error: 'Invalid cohort' });

  const { name, email, phone, message } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Valid email is required' });

  try {
    const cohort = await prisma.cohort.findUnique({ where: { id: cohortId } });
    if (!cohort || !cohort.isActive) return res.status(404).json({ error: 'Program not found' });

    const existing = await prisma.cohortEnrollment.findFirst({
      where: { cohortId, email: email.trim().toLowerCase() }
    });
    if (existing) return res.status(409).json({ error: 'You are already enrolled in this program.' });

    await prisma.cohortEnrollment.create({
      data: {
        cohortId,
        name:    sanitize(name.trim()),
        email:   email.trim().toLowerCase(),
        phone:   sanitize((phone || '').trim()) || null,
        message: sanitize((message || '').trim()) || null,
      }
    });

    wa.sendAdminConsultationAlert({
      name: sanitize(name.trim()),
      email: email.trim().toLowerCase(),
      phone: sanitize((phone || '').trim()) || null,
      message: `Cohort enrollment: "${cohort.name}" — ₹${cohort.price}`,
    }).catch(() => {});

    res.status(201).json({ success: true, message: `You have been added to the waitlist for "${cohort.name}". We will reach out with next steps!` });
  } catch (err) {
    console.error('Cohort enroll error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
