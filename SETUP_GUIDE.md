# MC Hardware Designer — One-Time Setup Guide

Follow these steps **once** before running the app for the first time.
After setup is complete, just double-click `START.bat` (Windows) or `START.command` (Mac) every time.

---

## Step 1 — Install Python

1. Go to **https://www.python.org/downloads/**
2. Click the big yellow **"Download Python 3.12.x"** button (this is the most stable version)
3. Run the installer
4. ⚠️ **IMPORTANT** — On the first screen of the installer, check the box that says:
   > ✅ **Add Python to PATH**

   (This box is at the bottom — do NOT skip this step)

5. Click **"Install Now"**
6. Once done, click **"Close"**

**Verify it worked** — open a terminal and run:
```
python --version
```
You should see something like `Python 3.12.x`

---

## Step 2 — Install Node.js

1. Go to **https://nodejs.org/**
2. Click the **"LTS"** version button (the one that says "Recommended For Most Users")
3. Run the installer
4. Click **Next** through all steps — the default settings are fine
5. When asked about **"Automatically install necessary tools"** — leave it **unchecked** (not needed)
6. Click **Install**, then **Finish**

**Verify it worked** — open a terminal and run:
```
node --version
npm --version
```
You should see version numbers for both.

---

## Step 3 — Install Claude CLI

1. Open **PowerShell** (search "PowerShell" in the Start menu)
2. Copy and paste this command, then press Enter:
   ```
   irm https://claude.ai/install.ps1 | iex
   ```
3. Wait for it to finish installing

**Verify it worked:**
```
claude --version
```
You should see a version number.

---

## Step 4 — Sign in to Claude CLI

This links the app to your Claude Pro subscription.

1. In the same PowerShell window, run:
   ```
   claude
   ```
2. It will open your browser automatically
3. Sign in with your **Claude account** (the one with your Pro subscription)
4. Once signed in, come back to the terminal — you'll see a confirmation message
5. Type `exit` and press Enter to close the Claude session

**Verify it worked:**
```
claude -p "hello"
```
Claude should reply with a short message.

> ⚠️ **Note:** If you ever get an error saying "not authenticated" when running the app,
> just run `claude` in a terminal again and sign in. This happens if the session expires.

---

## Step 5 — Run the App

You're all set! From now on, just:

- **Windows:** Double-click `START.bat`
- **Mac:** Double-click `START.command`
  *(First time on Mac: right-click → Open, to allow it)*
- **Linux:** Run `bash START.sh` in a terminal

The launcher will handle everything else automatically.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `python` not found | Re-install Python and make sure to check "Add Python to PATH" |
| `npm` not found | Re-install Node.js |
| `claude` not found | Re-run the Claude CLI install command in Step 3 |
| "Claude not authenticated" | Run `claude` in terminal and sign in again |
| Backend window closes immediately | Open it manually: activate `.venv`, go to `backend/`, run `uvicorn main:app --reload --port 8000` and read the error |
| Port 8000 already in use | Another program is using port 8000 — restart your PC and try again |
| Browser shows blank page | Wait 5 more seconds and refresh — servers may still be booting |
