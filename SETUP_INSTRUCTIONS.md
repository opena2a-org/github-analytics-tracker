# 🚀 GitHub Analytics Tracker - Setup Instructions

## What's Already Done ✅

1. ✅ GitHub Actions workflow created (`.github/workflows/collect-stats.yml`)
2. ✅ All necessary scripts created (`setup-database.js`, `collect-stats.js`)
3. ✅ Dashboard and API endpoints ready
4. ✅ `.env` file created with 3 repos configured:
   - `opena2a-org/agent-identity-management`
   - `opena2a-org/opena2a-website`
   - `opena2a-org/github-analytics-tracker`

## What You Need to Do 📋

### Step 1: Get Your GitHub Personal Access Token

1. Go to: https://github.com/settings/tokens/new
2. Give it a name: `GitHub Analytics Token`
3. Select scopes:
   - ✅ `repo` (for private repos) OR
   - ✅ `public_repo` (for public repos only)
4. Click "Generate token"
5. **Copy the token** (starts with `ghp_`) - you won't see it again!

### Step 2: Add Token to Local .env

1. Open `/Users/decimai/workspace/github-analytics-tracker/.env`
2. Replace `YOUR_GITHUB_TOKEN_HERE` with your actual token
3. Save the file

### Step 3: Set Up GitHub Actions (Automated Daily Collection)

1. Go to: https://github.com/opena2a-org/github-analytics-tracker/settings/secrets/actions
2. Click **"New repository secret"**
3. Add secret:
   - **Name**: `GH_STATS_TOKEN`
   - **Value**: Your GitHub token (the one you just created)
4. Click **"Add secret"**

5. Now add the variable:
   - Go to the **"Variables"** tab (next to Secrets)
   - Click **"New repository variable"**
   - Add variable:
     - **Name**: `REPOS_TO_TRACK`
     - **Value**: `opena2a-org/agent-identity-management,opena2a-org/opena2a-website,opena2a-org/github-analytics-tracker`
   - Click **"Add variable"**

### Step 4: Run Initial Data Collection (Local)

```bash
cd /Users/decimai/workspace/github-analytics-tracker

# Install dependencies
npm install

# Set up the database
npm run setup-db

# Collect the available 14 days of data from GitHub
npm run collect
```

This will:
- Create `data/analytics.db` SQLite database
- Fetch the last 14 days of traffic data from GitHub
- Store views, clones, stars, forks, referrers, and popular paths

### Step 5: Start the Dashboard

```bash
npm run dev
```

Open http://localhost:3000 to view your analytics!

### Step 6: Verify GitHub Actions (Optional)

1. Go to: https://github.com/opena2a-org/github-analytics-tracker/actions
2. Click on the **"Collect GitHub Stats"** workflow
3. Click **"Run workflow"** → **"Run workflow"** (manual trigger)
4. Wait for the workflow to complete
5. Check that the `data/analytics.db` file was committed

## What Happens Next 🔄

- **Every day at 2:00 AM UTC**, GitHub Actions will:
  1. Collect new stats for all tracked repos
  2. Update the SQLite database
  3. Commit and push the changes
  4. Build historical data beyond GitHub's 14-day limit

## Troubleshooting 🔧

### "Module not found: better-sqlite3"
```bash
npm install
```

### "Database not found"
```bash
npm run setup-db
```

### "API rate limit exceeded"
- You need to add your `GITHUB_TOKEN` to `.env`
- Without authentication, GitHub limits you to 60 requests/hour
- With authentication, you get 5,000 requests/hour

### "GitHub Actions workflow not running"
- Check that secrets and variables are set correctly
- Go to repo Settings → Actions → General
- Ensure "Allow all actions and reusable workflows" is enabled

## Next Steps 🎯

1. Run the initial collection now to capture the available 14 days
2. Set up GitHub Actions so you don't lose any future data
3. Check the dashboard daily to monitor your growth!

---

Need help? Open an issue on GitHub!
