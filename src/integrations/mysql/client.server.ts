import mysql from "mysql2/promise";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";

// Explicitly load .env file from the project root
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

console.log("[MySQL Init] Loaded environment variables:", {
  MYSQL_HOST: process.env.MYSQL_HOST,
  MYSQL_PORT: process.env.MYSQL_PORT,
  MYSQL_USER: process.env.MYSQL_USER,
  MYSQL_DATABASE: process.env.MYSQL_DATABASE,
  MYSQL_PASSWORD: process.env.MYSQL_PASSWORD ? "*** masked ***" : undefined,
});

let pool: mysql.Pool | null = null;
let hasWarned = false;

// Mock database tables for in-memory fallback
const mockDrafts: any[] = [];
const mockPostResults: any[] = [];

function getPool(): mysql.Pool | null {
  if (pool) return pool;

  const host = process.env.MYSQL_HOST;
  const port = process.env.MYSQL_PORT ? parseInt(process.env.MYSQL_PORT, 10) : 3306;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;
  const database = process.env.MYSQL_DATABASE;

  const isMissing = !host || !user || !database;
  const isTemplate = password === "your_mysql_password";

  if (isMissing || isTemplate) {
    if (!hasWarned) {
      console.warn(
        "[MySQL] Default template credentials or missing variables detected. Falling back to in-memory mock client."
      );
      hasWarned = true;
    }
    return null;
  }

  hasWarned = false;

  pool = mysql.createPool({
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  return pool;
}

// Verify connection at startup
async function verifyConnection() {
  const currentPool = getPool();
  if (!currentPool) {
    return;
  }
  try {
    await currentPool.execute("SELECT 1");
    console.log(`✅ Connected to MySQL: ${process.env.MYSQL_DATABASE}`);
  } catch (err: any) {
    console.error(`❌ Failed to connect to MySQL database during startup (${process.env.MYSQL_DATABASE}):`);
    console.error(err);
    throw err; // Fail loudly
  }
}

verifyConnection().catch((err) => {
  console.error("Critical: MySQL connection verification failed on startup.", err);
});

export async function mysqlQuery<T = any>(sql: string, params?: any[]): Promise<T> {
  const currentPool = getPool();
  if (!currentPool) {
    return executeMockQuery(sql, params) as T;
  }

  // Execute directly without wrapping in a silent fallback.
  // Connection/query errors will bubble up and display the actual MySQL error.
  const [results] = await currentPool.execute(sql, params);
  
  // Format JSON columns if they come back as strings
  if (Array.isArray(results)) {
    return results.map((row: any) => {
      const formatted = { ...row };
      if (typeof formatted.hashtags === "string") {
        try {
          formatted.hashtags = JSON.parse(formatted.hashtags);
        } catch {}
      }
      if (typeof formatted.channels === "string") {
        try {
          formatted.channels = JSON.parse(formatted.channels);
        } catch {}
      }
      return formatted;
    }) as T;
  }

  return results as T;
}

function executeMockQuery(sql: string, params: any[] = []): any {
  const normalized = sql.trim().replace(/\s+/g, " ").replace(/`/g, "").toLowerCase();
  
  // 1. DELETE FROM drafts WHERE run_date = ? AND status = 'pending'
  if (normalized.startsWith("delete from drafts where run_date = ? and status = 'pending'")) {
    const runDate = params[0];
    for (let i = mockDrafts.length - 1; i >= 0; i--) {
      if (mockDrafts[i].run_date === runDate && mockDrafts[i].status === "pending") {
        mockDrafts.splice(i, 1);
      }
    }
    return { affectedRows: 1 };
  }
  
  // 2. SELECT * FROM drafts WHERE run_date = ? ORDER BY rank ASC
  if (normalized.startsWith("select * from drafts where run_date = ? order by rank asc")) {
    const runDate = params[0];
    const results = mockDrafts.filter((d) => d.run_date === runDate);
    results.sort((a, b) => a.rank - b.rank);
    return results.map((r) => ({ ...r }));
  }

  // 2b. SELECT url, title FROM drafts WHERE run_date = ?
  if (normalized.startsWith("select url, title from drafts where run_date = ?")) {
    const runDate = params[0];
    const results = mockDrafts.filter((d) => d.run_date === runDate);
    return results.map((r) => ({ url: r.url, title: r.title }));
  }

  // 2c. SELECT url, title FROM drafts WHERE run_date = ? AND id != ?
  if (normalized.startsWith("select url, title from drafts where run_date = ? and id != ?")) {
    const [runDate, excludeId] = params;
    const results = mockDrafts.filter((d) => d.run_date === runDate && d.id !== excludeId);
    return results.map((r) => ({ url: r.url, title: r.title }));
  }

  // 3. SELECT * FROM drafts WHERE id = ?
  if (normalized.startsWith("select * from drafts where id = ?")) {
    const id = params[0];
    const results = mockDrafts.filter((d) => d.id === id);
    return results.map((r) => ({ ...r }));
  }

  // 4a. SELECT * FROM post_results WHERE draft_id = ?
  if (normalized.startsWith("select * from post_results where draft_id = ?")) {
    const draftId = params[0];
    const results = mockPostResults.filter((p) => p.draft_id === draftId);
    return results.map((r) => ({ ...r }));
  }

  // 4b. SELECT * FROM post_results WHERE draft_id IN (...)
  if (normalized.includes("select * from post_results where draft_id in")) {
    const idSet = new Set(params);
    const results = mockPostResults.filter((p) => idSet.has(p.draft_id));
    return results.map((r) => ({ ...r }));
  }

  // 5. UPDATE drafts SET title = ?, summary = ?, caption = ?, hashtags = ?, channels = ? WHERE id = ?
  if (normalized.startsWith("update drafts set title = ?, summary = ?, caption = ?, hashtags = ?, channels = ? where id = ?")) {
    const [title, summary, caption, hashtags, channels, id] = params;
    const target = mockDrafts.find((d) => d.id === id);
    if (target) {
      if (title !== undefined) target.title = title;
      if (summary !== undefined) target.summary = summary;
      if (caption !== undefined) target.caption = caption;
      if (hashtags !== undefined) target.hashtags = typeof hashtags === "string" ? JSON.parse(hashtags) : hashtags;
      if (channels !== undefined) target.channels = typeof channels === "string" ? JSON.parse(channels) : channels;
      target.updated_at = new Date().toISOString();
    }
    return { affectedRows: 1 };
  }

  // 6. UPDATE drafts SET status = ? WHERE id = ?
  if (normalized.startsWith("update drafts set status = ? where id = ?")) {
    const [status, id] = params;
    const target = mockDrafts.find((d) => d.id === id);
    if (target) {
      target.status = status;
      target.updated_at = new Date().toISOString();
    }
    return { affectedRows: 1 };
  }

  // 7a. UPDATE drafts SET status = ?, approved_at = NOW(), updated_at = NOW() WHERE id = ?
  if (normalized.includes("update drafts set status = ?, approved_at = now(), updated_at = now() where id = ?")) {
    const [status, id] = params;
    const target = mockDrafts.find((d) => d.id === id);
    if (target) {
      target.status = status;
      target.approved_at = new Date().toISOString();
      target.updated_at = new Date().toISOString();
    }
    return { affectedRows: 1 };
  }

  // 7b. UPDATE drafts SET status = ?, approved_at = ? WHERE id = ?
  if (normalized.startsWith("update drafts set status = ?, approved_at = ? where id = ?")) {
    const [status, approved_at, id] = params;
    const target = mockDrafts.find((d) => d.id === id);
    if (target) {
      target.status = status;
      target.approved_at = approved_at;
      target.updated_at = new Date().toISOString();
    }
    return { affectedRows: 1 };
  }

  // 8. UPDATE drafts SET details for regenerate Single Draft
  if (normalized.includes("update drafts set title = ?, source = ?, url = ?, summary = ?, topic = ?, caption = ?, hashtags = ?, image_path = ?, image_url = ?, updated_at = now() where id = ?")) {
    const [title, source, url, summary, topic, caption, hashtags, image_path, image_url, id] = params;
    const target = mockDrafts.find((d) => d.id === id);
    if (target) {
      target.title = title;
      target.source = source;
      target.url = url;
      target.summary = summary;
      target.topic = topic;
      target.caption = caption;
      target.hashtags = typeof hashtags === "string" ? JSON.parse(hashtags) : hashtags;
      target.image_path = image_path;
      target.image_url = image_url;
      target.updated_at = new Date().toISOString();
    }
    return { affectedRows: 1 };
  }

  if (normalized.includes("update drafts set image_path = ?, image_url = ?, updated_at = now() where id = ?")) {
    const [image_path, image_url, id] = params;
    const target = mockDrafts.find((d) => d.id === id);
    if (target) {
      target.image_path = image_path;
      target.image_url = image_url;
      target.updated_at = new Date().toISOString();
    }
    return { affectedRows: 1 };
  }

  if (normalized.includes("update drafts set caption = ?, updated_at = now() where id = ?")) {
    const [caption, id] = params;
    const target = mockDrafts.find((d) => d.id === id);
    if (target) {
      target.caption = caption;
      target.updated_at = new Date().toISOString();
    }
    return { affectedRows: 1 };
  }

  if (normalized.includes("update drafts set hashtags = ?, updated_at = now() where id = ?")) {
    const [hashtags, id] = params;
    const target = mockDrafts.find((d) => d.id === id);
    if (target) {
      target.hashtags = typeof hashtags === "string" ? JSON.parse(hashtags) : hashtags;
      target.updated_at = new Date().toISOString();
    }
    return { affectedRows: 1 };
  }

  // 9. INSERT INTO drafts
  if (normalized.startsWith("insert into drafts")) {
    const [id, run_date, rank, title, source, url, summary, topic, image_path, image_url, caption, hashtags, channels, status] = params;
    const newDraft = {
      id,
      run_date,
      rank,
      title,
      source,
      url,
      summary,
      topic,
      image_path,
      image_url,
      caption,
      hashtags: typeof hashtags === "string" ? JSON.parse(hashtags) : hashtags,
      channels: typeof channels === "string" ? JSON.parse(channels) : channels,
      status,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      approved_at: null,
      approved_by: null,
    };
    mockDrafts.push(newDraft);
    return { insertId: id };
  }

  // 10. INSERT INTO post_results
  if (normalized.startsWith("insert into post_results")) {
    const [id, draft_id, channel, status, posted_url, error] = params;
    const newResult = {
      id,
      draft_id,
      channel,
      status,
      posted_url,
      error,
      posted_at: new Date().toISOString(),
    };
    mockPostResults.push(newResult);
    return { insertId: id };
  }

  console.warn("Unrecognized mock SQL query:", sql, params);
  return [];
}
