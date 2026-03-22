const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'theanirudhcode.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    source TEXT DEFAULT 'free-guide',
    subscribed_at TEXT DEFAULT (datetime('now')),
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS consultations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    preferred_date TEXT,
    message TEXT,
    status TEXT DEFAULT 'new' CHECK(status IN ('new','read','contacted','completed')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    tags TEXT,
    excerpt TEXT NOT NULL,
    content TEXT NOT NULL,
    canvas_type TEXT DEFAULT 'gut',
    published INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    phone TEXT,
    role TEXT DEFAULT 'patient' CHECK(role IN ('patient', 'admin')),
    created_at TEXT DEFAULT (datetime('now')),
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    time_start TEXT NOT NULL,
    time_end TEXT NOT NULL,
    status TEXT DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled','completed','rescheduled')),
    health_concerns TEXT,
    medical_history TEXT,
    goals TEXT,
    google_event_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS google_tokens (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    access_token TEXT,
    refresh_token TEXT,
    expiry TEXT,
    calendar_id TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_subscribers_email ON subscribers(email);
  CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug);
  CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category);
  CREATE INDEX IF NOT EXISTS idx_consultations_status ON consultations(status);
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_appointments_user ON appointments(user_id);
  CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
  CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
`);

// Seed blog posts
const insertPost = db.prepare(
  'INSERT OR IGNORE INTO posts (title, slug, category, tags, excerpt, content, canvas_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);

insertPost.run(
  'Why Calorie Counting is an Incomplete Concept',
  'calorie-counting-incomplete',
  'Nutrition',
  'Metabolic Health,Biohacking',
  'Fat loss equals an energy deficit — but health optimisation is not just calories. Hormones, food quality, and your metabolic state matter more than the number on the label.',
  `<p>The fitness industry has reduced human metabolism to a simple equation: calories in vs. calories out. While thermodynamics is real, this reductionist view ignores the complex hormonal orchestra that governs how your body processes, stores, and burns energy.</p>

<h2>The Hormonal Reality</h2>
<p>When you eat matters as much as what you eat. Insulin, cortisol, ghrelin, and leptin form an intricate feedback loop that determines whether your body stores fat or burns it. A 500-calorie meal of processed carbohydrates triggers a vastly different hormonal cascade than 500 calories of whole foods rich in protein, healthy fats, and fibre.</p>

<h2>Why Calorie Counting Falls Short</h2>
<p>Chronic caloric restriction without hormonal awareness leads to metabolic adaptation — your body lowers its basal metabolic rate, increases hunger hormones, and becomes more efficient at storing fat. You lose weight initially, plateau, then regain. Sound familiar?</p>

<h2>The Better Approach</h2>
<p>Focus on metabolic flexibility — the ability of your body to switch between burning glucose and fat efficiently. This is achieved through:</p>
<ul>
<li>Strategic intermittent fasting to improve insulin sensitivity</li>
<li>Prioritising whole, nutrient-dense foods over processed alternatives</li>
<li>Timing carbohydrate intake around activity and circadian rhythm</li>
<li>Supporting gut health to optimise nutrient absorption</li>
<li>Managing stress and sleep to regulate cortisol</li>
</ul>

<h2>The Bottom Line</h2>
<p>Calorie awareness is a useful tool — but it is incomplete without hormonal intelligence. True metabolic health comes from understanding your body's biochemistry, not just counting numbers on a label.</p>`,
  'gut',
  '2026-01-15'
);

insertPost.run(
  'The Truth About Intermittent Fasting & Hair Loss',
  'intermittent-fasting-hair-loss',
  'Intermittent Fasting',
  'Fasting,Autophagy,Hormones',
  'Prolonged fasting affects nutrient availability, hormonal rhythms and cellular repair — understanding these nuances is the difference between healing and harm.',
  `<p>Intermittent fasting has transformed millions of lives. But a growing number of practitioners — particularly women — report unexpected hair loss after starting a fasting protocol. Is fasting to blame? The answer is more nuanced than a simple yes or no.</p>

<h2>The Nutrient Connection</h2>
<p>Hair follicles are among the most metabolically active cells in your body. They require a constant supply of iron, zinc, biotin, protein, and essential fatty acids. When you compress your eating window without increasing nutrient density, deficiencies accumulate silently — until your hair tells the story.</p>

<h2>The Hormonal Angle</h2>
<p>Extended fasting can lower thyroid hormone (T3) production and increase cortisol. Both directly impact the hair growth cycle. For women, fasting can also affect oestrogen and progesterone balance, pushing more follicles into the telogen (shedding) phase.</p>

<h2>The Fix: Intelligent Fasting</h2>
<p>Fasting itself is not the villain — uninformed fasting is. Here is how to fast without sacrificing your hair:</p>
<ul>
<li>Keep your eating window nutrient-dense: prioritise protein (at least 1.2g/kg body weight), iron-rich foods, and healthy fats</li>
<li>Supplement strategically: zinc, biotin, vitamin D, and omega-3s</li>
<li>Limit extended fasts (24+ hours) unless under professional guidance</li>
<li>Monitor thyroid markers (TSH, free T3, free T4) if hair loss persists</li>
<li>Women should consider cycle-synced fasting — shorter fasts during the luteal phase</li>
</ul>

<h2>The Takeaway</h2>
<p>Your body speaks through symptoms. Hair loss during fasting is not a sign that fasting is bad — it is a sign that your approach needs refinement. Listen to the signal, adjust the protocol, and your body will respond.</p>`,
  'breath',
  '2026-02-08'
);

insertPost.run(
  'Sugar, Insulin & the Disease Nobody Explains Properly',
  'sugar-insulin-disease',
  'Metabolic Biochemistry',
  'Hormones,Metabolic Health,Insulin',
  'The sugar problem goes far deeper than cravings. Anirudh breaks down the biochemistry of insulin resistance — and why the standard advice keeps people stuck.',
  `<p>Every chronic disease epidemic of the 21st century — type 2 diabetes, heart disease, PCOS, Alzheimer's, fatty liver — shares a common root that mainstream medicine consistently underexplains: chronic hyperinsulinaemia, or persistently elevated insulin levels.</p>

<h2>What Actually Happens When You Eat Sugar</h2>
<p>When glucose enters your bloodstream, your pancreas releases insulin — a storage hormone. Insulin's job is to shuttle glucose into cells for energy. But when you eat sugar frequently, in large amounts, or in highly processed forms, your cells become resistant to insulin's signal. The pancreas compensates by producing more insulin. This is insulin resistance — and it is the precursor to nearly every metabolic disease.</p>

<h2>Why Standard Advice Fails</h2>
<p>The conventional approach — "eat less sugar, exercise more" — addresses the surface while ignoring the biochemistry beneath it. Here is what most doctors do not explain:</p>
<ul>
<li>Insulin resistance can exist for 10–15 years before blood sugar levels become abnormal</li>
<li>Standard fasting glucose tests miss early insulin resistance entirely</li>
<li>Fruit juice, whole wheat bread, and "healthy" cereals can spike insulin just as much as candy</li>
<li>Chronic stress and poor sleep independently worsen insulin resistance</li>
<li>Gut dysbiosis directly impairs glucose metabolism</li>
</ul>

<h2>The Real Solution</h2>
<p>Reversing insulin resistance requires a multi-system approach:</p>
<ul>
<li><strong>Nutrition:</strong> Reduce refined carbohydrates, increase healthy fats and protein, eat in alignment with your circadian rhythm</li>
<li><strong>Fasting:</strong> Strategic intermittent fasting to lower baseline insulin levels and restore sensitivity</li>
<li><strong>Movement:</strong> Resistance training and post-meal walks to improve glucose uptake</li>
<li><strong>Sleep:</strong> 7–8 hours of quality sleep — sleep deprivation increases insulin resistance by up to 40%</li>
<li><strong>Stress:</strong> Chronic cortisol elevation directly antagonises insulin function</li>
</ul>

<h2>The Wake-Up Call</h2>
<p>Insulin resistance is not a disease — it is a metabolic state that your body enters in response to lifestyle signals. Change the signals, and the body responds. This is not theory — this is biochemistry. And it is reversible.</p>`,
  'ayur2',
  '2026-02-22'
);

// Seed default settings
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('working_hours_start', '09:00');
insertSetting.run('working_hours_end', '18:00');
insertSetting.run('slot_duration', '60');
insertSetting.run('working_days', '1,2,3,4,5');
insertSetting.run('booking_lead_hours', '24');

// Seed admin user
const adminHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'healtherealyou2026', 10);
const insertAdmin = db.prepare(
  'INSERT OR IGNORE INTO users (name, email, password_hash, phone, role) VALUES (?, ?, ?, ?, ?)'
);
insertAdmin.run('Dr. Anirudh', 'admin@theanirudhcode.com', adminHash, '', 'admin');

console.log('Database initialized with schema and seed data.');
db.close();
