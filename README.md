# Manuscripts Daily — Automatic Social Post Pipeline

Manuscripts Daily is a modern, automated pipeline and curation dashboard designed to discover, rank, summarize, and generate social media assets (editorial posters, captions, and hashtags) for manuscript studies and academic publications.

Originally built on Supabase, the application has been completely migrated to a local **MySQL** database architecture. It features a transparent in-memory mock fallback engine to keep development crash-free and supports independent, live regeneration of individual assets directly from the UI.

---

## 🚀 Key Features

1. **MySQL Database Caching & Persistence**:
   - Persists social post drafts and publication logs locally in a MySQL database.
   - Features timezone-safe, string-formatted date queries to prevent date shifts on page refreshes.
   - Escapes reserved keywords (e.g. `` `rank` ``) to support modern MySQL versions (8.0+).

2. **Zero-Config Developer Fallback**:
   - If MySQL credentials are not configured or the connection fails, the application automatically logs a console warning and falls back to a stateless, in-memory mock SQL interpreter so developers can work on frontend layouts immediately.

3. **Daily Pipeline Curation**:
   - Searches Google News RSS feed for trending manuscript topics (split into **historical** and **academic** categories).
   - Shortlists news items and ranks them using the Gemini API.
   - Generates editorial SVG posters with cycling visual themes, captions, and relevant hashtags.

4. **Refreshes & Next-Day Clean State**:
   - **Same day**: Reloading the website on the same day fetches the existing drafts from the database rather than repeating the pipeline or showing an empty state.
   - **Next day**: The dashboard starts fresh with an empty state on a new calendar day. Clicking **Run today** generates the new day's drafts.

5. **Independent Asset Regeneration**:
   - Regenerate the **Image**, **Caption**, or **Hashtags** independently.
   - Displays section-specific loading overlays during regeneration while keeping other content unchanged.

---

## 🛠️ Tech Stack

- **Core**: TypeScript, React, Vite
- **Meta-Framework**: TanStack Start / Vinxi
- **Database**: MySQL (`mysql2` connection pooling)
- **Styling**: Vanilla CSS with modern HSL palettes & glassmorphism overlays
- **AI Integration**: Gemini API & OpenAI Image Generation models

---

## ⚙️ Getting Started

### 1. Database Initialization
Ensure you have a local MySQL server running. Connect to it and run the following DDL script to create the schema:

```sql
-- 1. Create and select the database
CREATE DATABASE IF NOT EXISTS veda_db;
USE veda_db;

-- 2. Create drafts table
CREATE TABLE IF NOT EXISTS drafts (
  id VARCHAR(36) PRIMARY KEY,
  run_date DATE NOT NULL,
  `rank` INT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  summary TEXT NOT NULL,
  topic TEXT NOT NULL,
  image_path TEXT NOT NULL,
  image_url LONGTEXT,
  caption TEXT,
  hashtags JSON,
  channels JSON,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  approved_at TIMESTAMP NULL,
  approved_by VARCHAR(50) NULL
);

-- 3. Create post_results table
CREATE TABLE IF NOT EXISTS post_results (
  id VARCHAR(36) PRIMARY KEY,
  draft_id VARCHAR(36) NOT NULL,
  channel VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL,
  posted_url TEXT,
  error TEXT,
  posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
);
```

### 2. Configure Environment Variables
Create a `.env` file in the root directory:

```ini
MYSQL_HOST="localhost"
MYSQL_PORT=3306
MYSQL_USER="root"
MYSQL_PASSWORD="your_mysql_password"
MYSQL_DATABASE="veda_db"

# Optional: Add your API key to enable live Gemini and Image Generation AI
API_KEY="your_gateway_api_key"
```

*Note: If no password is set on your local MySQL `root` user, set `MYSQL_PASSWORD=""`.*

### 3. Installation & Run
Install the dependencies and start the development server:

```bash
# Install dependencies
npm install

# Start the dev server
npm run dev
```

The application will be accessible at **http://localhost:8080/**.

---

## 🧪 Integration Verification

You can programmatically verify database connectivity, tables schema compliance, and asset regeneration queries by running the validation script:

```bash
npx vite-node src/integrations/mysql/client.server.ts
# or run the scratch verify utility
npx vite-node .gemini/antigravity-ide/brain/5a523967-5fec-4e25-b560-c848b466eb09/scratch/verify.ts
```

If successful, the startup log will output:
```text
[MySQL Init] Loaded environment variables: { ... }
✅ Connected to MySQL: veda_db
```
