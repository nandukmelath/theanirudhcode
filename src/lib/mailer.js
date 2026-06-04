/**
 * Mailer — Resend (primary) → SMTP/Gmail (fallback), 1 retry each
 */

const nodemailer = require('nodemailer');
const axios = require('axios');
const { google } = require('googleapis');
const prisma = require('./prisma');

const SMTP_FROM    = process.env.SMTP_FROM    || 'Dr. Anirudh | theanirudhcode <nandukannanmelath@gmail.com>';
// Resend requires a verified domain — always default to theanirudhcode.com address
const RESEND_FROM  = process.env.RESEND_FROM  || 'Dr. Anirudh | theanirudhcode <dranirudh@theanirudhcode.com>';
const GMAIL_FROM   = process.env.GMAIL_FROM   || 'Dr. Anirudh | theanirudhcode <dranirudh@theanirudhcode.com>';
const FROM_ADDRESS = SMTP_FROM; // used by SMTP; Resend uses RESEND_FROM

// ── Gmail API sender ──────────────────────────────────────────────────────────
// Uses the OAuth refresh token saved during /portal-management → "Connect Google Calendar".
// Same OAuth client now has gmail.send scope (added 2026-05-13). Practitioner must reconnect once.
async function sendViaGmail(to, subject, html) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return false;
  try {
    const stored = await prisma.googleToken.findUnique({ where: { id: 1 } });
    if (!stored || !stored.refreshToken) return false;

    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    oauth2.setCredentials({
      refresh_token: stored.refreshToken,
      access_token:  stored.accessToken || undefined,
      expiry_date:   stored.expiry ? parseInt(stored.expiry, 10) : undefined,
    });
    // Auto-refresh hook
    oauth2.on('tokens', async (tokens) => {
      try {
        await prisma.googleToken.update({
          where: { id: 1 },
          data: {
            accessToken: tokens.access_token || stored.accessToken,
            expiry:      tokens.expiry_date ? String(tokens.expiry_date) : stored.expiry,
          }
        });
      } catch (err) { console.error('[Gmail] token persist failed:', err.message); }
    });

    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const raw = Buffer.from(
      `From: ${GMAIL_FROM}\r\n` +
      `To: ${to}\r\n` +
      `Subject: ${subject}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `\r\n` +
      html
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    return true;
  } catch (err) {
    console.error('[Gmail API] send failed:', err.message);
    if (err.message && /invalid_grant|insufficient.*scope|gmail.*not.*enabled/i.test(err.message)) {
      console.error('[Gmail API] Practitioner needs to reconnect Google account with Gmail scope at /portal-management');
    }
    throw err; // let trySend retry
  }
}

async function sendViaResend(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return false;
  await axios.post('https://api.resend.com/emails', { from: RESEND_FROM, to, subject, html }, {
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    timeout: 10000,
  });
  return true;
}

async function sendViaSmtp(to, subject, html) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return false;
  const transporter = nodemailer.createTransport({
    host:              process.env.SMTP_HOST,
    port:              parseInt(process.env.SMTP_PORT) || 587,
    secure:            false,
    family:            4,     // Force IPv4 — Railway/GCP blocks IPv6 SMTP
    connectionTimeout: 8000,  // fail fast if GCP blocks the port
    greetingTimeout:   8000,
    socketTimeout:     10000,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({ from: FROM_ADDRESS, to, subject, html });
  return true;
}

async function trySend(fn, to, subject, html) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const sent = await fn(to, subject, html);
      if (!sent) return false; // provider not configured — skip to next
      return true;
    } catch (err) {
      console.error(`[Mailer] Attempt ${attempt} failed (${fn.name}):`, err.message);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }
  return false;
}

function welcomeEmailHtml(name) {
  const firstName = name.split(' ')[0];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to theanirudhcode</title>
</head>
<body style="margin:0;padding:0;background:#070707;font-family:'Georgia',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#070707;padding:40px 20px;">
  <tr>
    <td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0e0e0e;border:1px solid rgba(200,169,81,0.15);">

        <!-- Header -->
        <tr>
          <td style="padding:40px 48px 32px;border-bottom:1px solid rgba(200,169,81,0.11);text-align:center;">
            <div style="display:inline-block;width:8px;height:8px;background:#c8a951;transform:rotate(45deg);margin-bottom:16px;"></div>
            <div style="font-family:'Georgia',serif;font-size:22px;font-weight:300;letter-spacing:0.14em;color:#f8f4ec;">theanirudhcode</div>
            <div style="font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(200,169,81,0.7);margin-top:6px;">Heal the Real You</div>
          </td>
        </tr>

        <!-- Main Content -->
        <tr>
          <td style="padding:48px 48px 40px;">
            <p style="font-family:'Georgia',serif;font-size:28px;font-weight:300;color:#f8f4ec;margin:0 0 8px;line-height:1.3;">Welcome, <em style="color:#e2c97e;">${firstName}</em></p>
            <p style="font-size:13px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(200,169,81,0.7);margin:0 0 32px;font-family:Arial,sans-serif;">Your healing journey begins now</p>

            <p style="font-size:15px;color:rgba(248,244,236,0.75);line-height:1.9;margin:0 0 24px;font-family:Arial,sans-serif;font-weight:300;">
              You've taken the most important step — deciding that <em style="color:#e2c97e;">you deserve to heal</em>. Dr. Anirudh and the theanirudhcode community are here to walk every step of that journey with you.
            </p>

            <p style="font-size:15px;color:rgba(248,244,236,0.75);line-height:1.9;margin:0 0 36px;font-family:Arial,sans-serif;font-weight:300;">
              Your account is now active. You can book consultations, access personalised protocols, and track your healing progress — all from your dashboard.
            </p>

            <!-- Divider -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:36px;">
              <tr>
                <td style="height:1px;background:rgba(200,169,81,0.11);"></td>
              </tr>
            </table>

            <!-- What to Expect -->
            <p style="font-family:'Georgia',serif;font-size:18px;font-weight:300;color:#f8f4ec;margin:0 0 20px;">What to expect</p>

            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding:14px 0;border-bottom:1px solid rgba(200,169,81,0.07);">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td width="32" valign="top" style="font-family:'Georgia',serif;font-size:14px;color:#c8a951;padding-top:1px;">◆</td>
                      <td>
                        <div style="font-size:13px;font-family:Arial,sans-serif;font-weight:400;color:#f8f4ec;margin-bottom:4px;">Personalised Root-Cause Analysis</div>
                        <div style="font-size:12px;font-family:Arial,sans-serif;color:rgba(248,244,236,0.5);line-height:1.6;">A deep diagnostic to identify the true source of your imbalance — not just the symptoms.</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:14px 0;border-bottom:1px solid rgba(200,169,81,0.07);">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td width="32" valign="top" style="font-family:'Georgia',serif;font-size:14px;color:#c8a951;padding-top:1px;">◆</td>
                      <td>
                        <div style="font-size:13px;font-family:Arial,sans-serif;font-weight:400;color:#f8f4ec;margin-bottom:4px;">Bespoke Healing Protocol</div>
                        <div style="font-size:12px;font-family:Arial,sans-serif;color:rgba(248,244,236,0.5);line-height:1.6;">Custom blueprints spanning nutrition, breathwork, sleep, and Ayurvedic wisdom — built for your biology.</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:14px 0;border-bottom:1px solid rgba(200,169,81,0.07);">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td width="32" valign="top" style="font-family:'Georgia',serif;font-size:14px;color:#c8a951;padding-top:1px;">◆</td>
                      <td>
                        <div style="font-size:13px;font-family:Arial,sans-serif;font-weight:400;color:#f8f4ec;margin-bottom:4px;">Direct Access to Dr. Anirudh</div>
                        <div style="font-size:12px;font-family:Arial,sans-serif;color:rgba(248,244,236,0.5);line-height:1.6;">Book 1-on-1 consultations and get guided support through every stage of your transformation.</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:14px 0;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td width="32" valign="top" style="font-family:'Georgia',serif;font-size:14px;color:#c8a951;padding-top:1px;">◆</td>
                      <td>
                        <div style="font-size:13px;font-family:Arial,sans-serif;font-weight:400;color:#f8f4ec;margin-bottom:4px;">Free 7-Day Healing Reset Guide</div>
                        <div style="font-size:12px;font-family:Arial,sans-serif;color:rgba(248,244,236,0.5);line-height:1.6;">Your first step — a science-backed guide to resetting your gut, nervous system, and sleep in one week.</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <!-- Divider -->
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:36px 0;">
              <tr>
                <td style="height:1px;background:rgba(200,169,81,0.11);"></td>
              </tr>
            </table>

            <!-- Quote -->
            <table width="100%" cellpadding="0" cellspacing="0" style="border-left:2px solid rgba(200,169,81,0.4);padding-left:20px;margin-bottom:36px;">
              <tr>
                <td>
                  <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:rgba(248,244,236,0.65);line-height:1.8;margin:0;">
                    "You are not broken. You have simply been layered over with everything that was never yours to carry. Strip it away — and the real you heals itself."
                  </p>
                  <p style="font-size:11px;font-family:Arial,sans-serif;color:rgba(200,169,81,0.6);letter-spacing:0.15em;text-transform:uppercase;margin:12px 0 0;">— Dr. Anirudh M. Vaddineni</p>
                </td>
              </tr>
            </table>

            <!-- CTA Button -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center">
                  <a href="https://theanirudhcode.com" style="display:inline-block;background:#c8a951;color:#070707;text-decoration:none;padding:16px 40px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;font-weight:600;">Begin Your Journey →</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:28px 48px;border-top:1px solid rgba(200,169,81,0.11);text-align:center;">
            <p style="font-size:11px;font-family:Arial,sans-serif;color:rgba(248,244,236,0.3);margin:0 0 8px;line-height:1.7;">
              theanirudhcode · Hyderabad, India<br>
              <a href="https://theanirudhcode.com" style="color:rgba(200,169,81,0.5);text-decoration:none;">theanirudhcode.com</a>
            </p>
            <p style="font-size:10px;font-family:Arial,sans-serif;color:rgba(248,244,236,0.2);margin:0;letter-spacing:0.05em;">
              You're receiving this because you created an account at theanirudhcode.com
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function verificationEmailHtml(name, verifyUrl) {
  const firstName = name.split(' ')[0];
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verify Your Email — theanirudhcode</title></head>
<body style="margin:0;padding:0;background:#070707;font-family:'Georgia',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#070707;padding:40px 20px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0e0e0e;border:1px solid rgba(200,169,81,0.15);">
      <tr><td style="padding:40px 48px 32px;border-bottom:1px solid rgba(200,169,81,0.11);text-align:center;">
        <div style="display:inline-block;width:8px;height:8px;background:#c8a951;transform:rotate(45deg);margin-bottom:16px;"></div>
        <div style="font-family:'Georgia',serif;font-size:22px;font-weight:300;letter-spacing:0.14em;color:#f8f4ec;">theanirudhcode</div>
        <div style="font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(200,169,81,0.7);margin-top:6px;">Email Verification</div>
      </td></tr>
      <tr><td style="padding:48px 48px 40px;">
        <p style="font-family:'Georgia',serif;font-size:24px;font-weight:300;color:#f8f4ec;margin:0 0 24px;">Hello, <em style="color:#e2c97e;">${firstName}</em></p>
        <p style="font-size:15px;color:rgba(248,244,236,0.75);line-height:1.9;margin:0 0 32px;font-family:Arial,sans-serif;font-weight:300;">
          Thank you for creating an account at theanirudhcode. Click the button below to verify your email address and activate your account. This link expires in <strong style="color:#f8f4ec;">24 hours</strong>.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
          <tr><td align="center">
            <a href="${verifyUrl}" style="display:inline-block;background:#c8a951;color:#070707;text-decoration:none;padding:16px 40px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;font-weight:600;">Verify Email Address →</a>
          </td></tr>
        </table>
        <p style="font-size:12px;color:rgba(248,244,236,0.4);line-height:1.8;margin:0;font-family:Arial,sans-serif;">
          If you did not create this account, you can safely ignore this email.<br>
          This link expires in 24 hours.
        </p>
      </td></tr>
      <tr><td style="padding:28px 48px;border-top:1px solid rgba(200,169,81,0.11);text-align:center;">
        <p style="font-size:11px;font-family:Arial,sans-serif;color:rgba(248,244,236,0.3);margin:0;line-height:1.7;">
          theanirudhcode · Hyderabad, India &middot; <a href="https://theanirudhcode.com" style="color:rgba(200,169,81,0.5);text-decoration:none;">theanirudhcode.com</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function passwordResetEmailHtml(name, resetUrl) {
  const firstName = name.split(' ')[0];
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reset Your Password</title></head>
<body style="margin:0;padding:0;background:#070707;font-family:'Georgia',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#070707;padding:40px 20px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0e0e0e;border:1px solid rgba(200,169,81,0.15);">
      <tr><td style="padding:40px 48px 32px;border-bottom:1px solid rgba(200,169,81,0.11);text-align:center;">
        <div style="display:inline-block;width:8px;height:8px;background:#c8a951;transform:rotate(45deg);margin-bottom:16px;"></div>
        <div style="font-family:'Georgia',serif;font-size:22px;font-weight:300;letter-spacing:0.14em;color:#f8f4ec;">theanirudhcode</div>
        <div style="font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(200,169,81,0.7);margin-top:6px;">Password Reset</div>
      </td></tr>
      <tr><td style="padding:48px 48px 40px;">
        <p style="font-family:'Georgia',serif;font-size:24px;font-weight:300;color:#f8f4ec;margin:0 0 24px;">Hello, <em style="color:#e2c97e;">${firstName}</em></p>
        <p style="font-size:15px;color:rgba(248,244,236,0.75);line-height:1.9;margin:0 0 32px;font-family:Arial,sans-serif;font-weight:300;">
          We received a request to reset the password for your theanirudhcode account. Click the button below to set a new password. This link expires in <strong style="color:#f8f4ec;">1 hour</strong>.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
          <tr><td align="center">
            <a href="${resetUrl}" style="display:inline-block;background:#c8a951;color:#070707;text-decoration:none;padding:16px 40px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;font-weight:600;">Reset Password →</a>
          </td></tr>
        </table>
        <p style="font-size:12px;color:rgba(248,244,236,0.4);line-height:1.8;margin:0;font-family:Arial,sans-serif;">
          If you did not request a password reset, please ignore this email — your password will remain unchanged.<br>
          For security, this link expires in 1 hour.
        </p>
      </td></tr>
      <tr><td style="padding:28px 48px;border-top:1px solid rgba(200,169,81,0.11);text-align:center;">
        <p style="font-size:11px;font-family:Arial,sans-serif;color:rgba(248,244,236,0.3);margin:0 0 8px;line-height:1.7;">
          theanirudhcode · Hyderabad, India<br>
          <a href="https://theanirudhcode.com" style="color:rgba(200,169,81,0.5);text-decoration:none;">theanirudhcode.com</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function consultationReplyHtml(name, reply) {
  const firstName = name.split(' ')[0];
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Re: Your Consultation Request</title></head>
<body style="margin:0;padding:0;background:#070707;font-family:'Georgia',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#070707;padding:40px 20px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0e0e0e;border:1px solid rgba(200,169,81,0.15);">
      <tr><td style="padding:40px 48px 32px;border-bottom:1px solid rgba(200,169,81,0.11);text-align:center;">
        <div style="display:inline-block;width:8px;height:8px;background:#c8a951;transform:rotate(45deg);margin-bottom:16px;"></div>
        <div style="font-family:'Georgia',serif;font-size:22px;font-weight:300;letter-spacing:0.14em;color:#f8f4ec;">theanirudhcode</div>
        <div style="font-size:11px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(200,169,81,0.7);margin-top:6px;">Consultation Response</div>
      </td></tr>
      <tr><td style="padding:48px 48px 40px;">
        <p style="font-family:'Georgia',serif;font-size:24px;font-weight:300;color:#f8f4ec;margin:0 0 24px;">Hello, <em style="color:#e2c97e;">${firstName}</em></p>
        <p style="font-size:15px;color:rgba(248,244,236,0.75);line-height:1.9;margin:0 0 24px;font-family:Arial,sans-serif;font-weight:300;">
          Dr. Anirudh has responded to your consultation request:
        </p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-left:2px solid rgba(200,169,81,0.4);padding-left:20px;margin-bottom:32px;">
          <tr><td>
            <p style="font-family:Arial,sans-serif;font-size:15px;color:rgba(248,244,236,0.85);line-height:1.8;margin:0;white-space:pre-wrap;">${reply.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
            <p style="font-size:11px;font-family:Arial,sans-serif;color:rgba(200,169,81,0.6);letter-spacing:0.15em;text-transform:uppercase;margin:12px 0 0;">— Dr. Anirudh M. Vaddineni</p>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td align="center">
            <a href="https://theanirudhcode.com" style="display:inline-block;background:#c8a951;color:#070707;text-decoration:none;padding:16px 40px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;font-weight:600;">Visit theanirudhcode →</a>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:28px 48px;border-top:1px solid rgba(200,169,81,0.11);text-align:center;">
        <p style="font-size:11px;font-family:Arial,sans-serif;color:rgba(248,244,236,0.3);margin:0;line-height:1.7;">
          theanirudhcode · Hyderabad, India &middot; <a href="https://theanirudhcode.com" style="color:rgba(200,169,81,0.5);text-decoration:none;">theanirudhcode.com</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendPasswordResetEmail(email, name, resetUrl) {
  const subject = `Reset your theanirudhcode password`;
  const html    = passwordResetEmailHtml(name, resetUrl);
  for (const provider of [sendViaGmail, sendViaResend, sendViaSmtp]) {
    const sent = await trySend(provider, email, subject, html);
    if (sent) { console.log(`[Mailer] ✓ Password reset email sent via ${provider.name} to ${email}`); return true; }
  }
  console.error(`[Mailer] All delivery attempts failed for ${email}`);
  return false;
}

async function sendConsultationReply(email, name, reply) {
  const subject = `Re: Your consultation request — theanirudhcode`;
  const html    = consultationReplyHtml(name, reply);
  for (const provider of [sendViaGmail, sendViaResend, sendViaSmtp]) {
    const sent = await trySend(provider, email, subject, html);
    if (sent) { console.log(`[Mailer] ✓ Consultation reply sent via ${provider.name} to ${email}`); return true; }
  }
  console.error(`[Mailer] All delivery attempts failed for ${email}`);
  return false;
}

async function sendWelcomeEmail(email, name) {
  const subject = `Welcome to theanirudhcode, ${name.split(' ')[0]} — Your healing journey begins`;
  const html    = welcomeEmailHtml(name);
  for (const provider of [sendViaGmail, sendViaResend, sendViaSmtp]) {
    const sent = await trySend(provider, email, subject, html);
    if (sent) { console.log(`[Mailer] ✓ Welcome email sent via ${provider.name} to ${email}`); return true; }
  }
  console.error(`[Mailer] All delivery attempts failed for ${email}`);
  return false;
}

async function sendVerificationEmail(email, name, verifyUrl) {
  const subject = `Verify your email — theanirudhcode`;
  const html    = verificationEmailHtml(name, verifyUrl);
  for (const provider of [sendViaGmail, sendViaResend, sendViaSmtp]) {
    const sent = await trySend(provider, email, subject, html);
    if (sent) { console.log(`[Mailer] ✓ Verification email sent via ${provider.name} to ${email}`); return true; }
  }
  console.error(`[Mailer] All delivery attempts failed for ${email}`);
  return false;
}

// ── OTP email ──────────────────────────────────────────────────────────────────
function otpEmailHtml(code, purpose) {
  const heading = purpose === 'register' ? 'Confirm your sign-up' : 'Your sign-in code';
  return `<!DOCTYPE html><html><body style="font-family:Georgia,serif;background:#0a0a0a;color:#e8e8e8;margin:0;padding:40px 0">
    <div style="max-width:520px;margin:0 auto;background:#141414;border:1px solid #2a2a2a;border-radius:18px;padding:40px 32px">
      <h1 style="font-family:Georgia,serif;font-weight:300;color:#c8a951;font-size:28px;margin:0 0 8px">theanirudhcode</h1>
      <p style="color:#888;font-size:13px;letter-spacing:.18em;text-transform:uppercase;margin:0 0 28px">${heading}</p>
      <p style="color:#e8e8e8;font-size:15px;line-height:1.7;margin:0 0 24px">Enter this code to continue. It expires in <strong>10 minutes</strong>.</p>
      <div style="background:linear-gradient(135deg,rgba(200,169,81,.14),rgba(200,169,81,.03));border:1px solid rgba(200,169,81,.32);border-radius:14px;padding:28px;text-align:center;margin:0 0 28px">
        <div style="font-family:monospace;font-size:36px;letter-spacing:.4em;color:#c8a951;font-weight:600">${code}</div>
      </div>
      <p style="color:#666;font-size:12px;line-height:1.7;margin:0">If you didn't request this code, ignore this email — your account remains safe.</p>
    </div>
  </body></html>`;
}

async function sendOtpEmail(email, code, purpose = 'login') {
  const subject = purpose === 'register' ? `Confirm sign-up — code: ${code}` : `Your sign-in code: ${code}`;
  const html = otpEmailHtml(code, purpose);
  for (const provider of [sendViaGmail, sendViaResend, sendViaSmtp]) {
    const sent = await trySend(provider, email, subject, html);
    if (sent) { console.log(`[Mailer] ✓ OTP sent via ${provider.name} to ${email}`); return true; }
  }
  console.error(`[Mailer] OTP delivery failed for ${email}`);
  return false;
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail, sendConsultationReply, sendVerificationEmail, sendOtpEmail };
