# Google Calendar Setup Guide

Follow these steps to connect Google Calendar to theanirudhcode for real-time appointment scheduling.

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Click **Select a Project** → **New Project**
3. Name it `theanirudhcode-appointments`
4. Click **Create**

## Step 2: Enable Google Calendar API

1. In the left sidebar, go to **APIs & Services** → **Library**
2. Search for **Google Calendar API**
3. Click on it and press **Enable**

## Step 3: Configure OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**
2. Select **External** user type → **Create**
3. Fill in:
   - App name: `theanirudhcode Appointments`
   - User support email: your email
   - Developer contact: your email
4. Click **Save and Continue**
5. On the Scopes page, click **Add or Remove Scopes**
6. Search for and add: `https://www.googleapis.com/auth/calendar`
7. Click **Save and Continue**
8. On Test Users, click **Add Users** and add the Google account that owns your business calendar
9. Click **Save and Continue** → **Back to Dashboard**

## Step 4: Create OAuth 2.0 Credentials

1. Go to **APIs & Services** → **Credentials**
2. Click **Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `theanirudhcode Server`
5. Under **Authorized redirect URIs**, add:
   - `http://localhost:3000/api/calendar/oauth/callback`
   - (Add your production URL later, e.g., `https://yourdomain.com/api/calendar/oauth/callback`)
6. Click **Create**
7. Copy the **Client ID** and **Client Secret**

## Step 5: Add Credentials to .env

Open your `.env` file and fill in:

```
GOOGLE_CLIENT_ID=your-client-id-here
GOOGLE_CLIENT_SECRET=your-client-secret-here
GOOGLE_REDIRECT_URI=http://localhost:3000/api/calendar/oauth/callback
```

Restart the server after updating.

## Step 6: Create a Business Calendar (Recommended)

1. Open [Google Calendar](https://calendar.google.com)
2. On the left sidebar, click **+** next to **Other calendars**
3. Select **Create new calendar**
4. Name it: `theanirudhcode Appointments`
5. Click **Create calendar**
6. The calendar ID can be found in **Settings** → click on your new calendar → **Integrate calendar** → copy the **Calendar ID**

## Step 7: Connect from Admin Dashboard

1. Start your server: `npm start`
2. Go to `http://localhost:3000/admin`
3. Log in with your admin credentials
4. Click the **Calendar Setup** tab
5. Click **Connect Google Calendar**
6. Authorize the app when prompted by Google
7. After redirect, select your business calendar from the dropdown
8. Click **Use This Calendar**

## Done!

Patients can now book appointments and they will:
- Appear on your Google Calendar with full patient details
- Only show available time slots (respecting your calendar's busy times)
- Send calendar invites to patients automatically

## For Production Deployment

1. Update the redirect URI in both Google Cloud Console and your `.env`
2. If serving more than 100 users, submit your app for Google verification in the OAuth consent screen
3. Set `NODE_ENV=production` for secure cookies
