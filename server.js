require("dotenv").config();
const express = require("express");
const session = require("express-session");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_DISCORD_ID = process.env.ADMIN_DISCORD_ID || "1542554962087911543";
const db = new Database(path.join(__dirname, "data.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, global_name TEXT, avatar TEXT
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  sender_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS access_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS forms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL UNIQUE,
  answers TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

app.use(express.json({ limit: "100kb" }));
app.use(session({
  name: "uc.sid",
  secret: process.env.SESSION_SECRET || "dev-only-change-this-session-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

function userFrom(req) { return req.session && req.session.user; }
function isAdmin(user) { return !!user && user.id === ADMIN_DISCORD_ID; }
function requireLogin(req, res, next) {
  if (!userFrom(req)) return res.status(401).json({ error: "Iniciá sesión con Discord primero." });
  next();
}
function requireAdmin(req, res, next) {
  if (!isAdmin(userFrom(req))) return res.status(403).json({ error: "Solo el administrador puede hacer eso." });
  next();
}
function canAccessChat(user, chat) {
  return !!chat && (isAdmin(user) || chat.client_id === user.id);
}
function safeUser(u) {
  return { id: u.id, username: u.username, global_name: u.global_name || null, avatar: u.avatar || null, isAdmin: isAdmin(u) };
}
function addMessage(chatId, senderId, body) {
  return db.prepare("INSERT INTO messages (chat_id, sender_id, body) VALUES (?, ?, ?)").run(chatId, senderId, body);
}
function getChatForUser(user, id) {
  const chat = db.prepare(`
    SELECT c.*, u.username AS client_username, u.global_name AS client_global_name
    FROM chats c LEFT JOIN users u ON u.id = c.client_id WHERE c.id = ?
  `).get(id);
  return canAccessChat(user, chat) ? chat : null;
}

app.get("/auth/discord", (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = process.env.DISCORD_REDIRECT_URI || `${BASE_URL}/auth/callback`;
  if (!clientId || !process.env.DISCORD_CLIENT_SECRET) return res.status(503).send("Falta configurar Discord OAuth en las variables privadas del servidor.");
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code",
    scope: "identify", state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/callback", async (req, res) => {
  try {
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState) return res.status(400).send("No se pudo validar el inicio de sesión. Volvé a intentarlo.");
    delete req.session.oauthState;
    const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: String(req.query.code),
        redirect_uri: process.env.DISCORD_REDIRECT_URI || `${BASE_URL}/auth/callback`
      })
    });
    if (!tokenResponse.ok) throw new Error("Discord no aceptó la autorización.");
    const token = await tokenResponse.json();
    const profileResponse = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });
    if (!profileResponse.ok) throw new Error("No se pudo leer el perfil de Discord.");
    const profile = await profileResponse.json();
    const user = {
      id: profile.id, username: profile.username,
      global_name: profile.global_name || null, avatar: profile.avatar || null
    };
    db.prepare(`INSERT INTO users (id, username, global_name, avatar) VALUES (@id,@username,@global_name,@avatar)
      ON CONFLICT(id) DO UPDATE SET username=excluded.username, global_name=excluded.global_name, avatar=excluded.avatar`).run(user);
    req.session.user = user;
    res.redirect("/");
  } catch (e) {
    console.error("OAuth error:", e.message);
    res.status(500).send("Hubo un problema al iniciar sesión con Discord. Revisá la configuración e intentá de nuevo.");
  }
});

app.get("/api/me", (req, res) => res.json({ user: userFrom(req) ? safeUser(userFrom(req)) : null }));

app.post("/api/logout", requireLogin, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/chats", requireLogin, (req, res) => {
  const user = userFrom(req);
  let chats;
  if (isAdmin(user)) {
    chats = db.prepare(`SELECT c.*, u.username AS client_username, u.global_name AS client_global_name,
      (SELECT body FROM messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) AS last_message_at,
      EXISTS(SELECT 1 FROM forms f WHERE f.chat_id=c.id) AS has_form
      FROM chats c LEFT JOIN users u ON u.id=c.client_id ORDER BY COALESCE(last_message_at,c.created_at) DESC`).all();
  } else {
    chats = db.prepare(`SELECT c.*,
      (SELECT body FROM messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1) AS last_message_at,
      EXISTS(SELECT 1 FROM forms f WHERE f.chat_id=c.id) AS has_form
      FROM chats c WHERE c.client_id=? ORDER BY c.id DESC`).all(user.id);
  }
  res.json({ chats });
});

app.post("/api/chats", requireLogin, (req, res) => {
  const user = userFrom(req);
  if (isAdmin(user)) return res.status(400).json({ error: "Como administrador, elegí un chat de un cliente." });
  const existing = db.prepare("SELECT id FROM chats WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1").get(user.id);
  if (existing) return res.json({ chatId: existing.id, existing: true });
  const result = db.prepare("INSERT INTO chats (client_id) VALUES (?)").run(user.id);
  const chatId = Number(result.lastInsertRowid);
  addMessage(chatId, user.id, "¡Hola! Quiero consultar por un proyecto de Ultimate Creations.");
  res.json({ chatId, existing: false });
});

app.get("/api/chats/:id/messages", requireLogin, (req, res) => {
  const user = userFrom(req);
  const chat = getChatForUser(user, Number(req.params.id));
  if (!chat) return res.status(404).json({ error: "No se encontró ese chat." });
  const messages = db.prepare(`SELECT m.*, u.username AS sender_username, u.global_name AS sender_global_name
    FROM messages m LEFT JOIN users u ON u.id=m.sender_id WHERE m.chat_id=? ORDER BY m.id`).all(chat.id);
  res.json({ chat, messages, isAdmin: isAdmin(user) });
});

app.post("/api/chats/:id/messages", requireLogin, (req, res) => {
  const user = userFrom(req);
  const chat = getChatForUser(user, Number(req.params.id));
  const body = String(req.body.body || "").trim();
  if (!chat) return res.status(404).json({ error: "No se encontró ese chat." });
  if (!body || body.length > 2000) return res.status(400).json({ error: "El mensaje debe tener entre 1 y 2000 caracteres." });
  addMessage(chat.id, user.id, body);
  res.json({ ok: true });
});

app.post("/api/chats/:id/access-code", requireLogin, requireAdmin, (req, res) => {
  const chat = db.prepare("SELECT * FROM chats WHERE id=?").get(Number(req.params.id));
  if (!chat) return res.status(404).json({ error: "No se encontró ese chat." });
  const code = `UC-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  db.prepare("INSERT INTO access_codes (chat_id, code_hash, expires_at) VALUES (?, ?, ?)").run(chat.id, hash, Date.now() + 72 * 60 * 60 * 1000);
  addMessage(chat.id, userFrom(req).id, `Ya podés completar el formulario de tu pedido. Entrá en «Formulario» y escribí esta clave: ${code}\nLa clave vence en 72 horas y se usa una sola vez.`);
  res.json({ ok: true });
});

app.post("/api/chats/:id/form-access", requireLogin, (req, res) => {
  const user = userFrom(req);
  const chat = getChatForUser(user, Number(req.params.id));
  if (!chat || isAdmin(user)) return res.status(404).json({ error: "No se encontró ese chat." });
  if (db.prepare("SELECT id FROM forms WHERE chat_id=?").get(chat.id)) return res.status(400).json({ error: "Este formulario ya fue enviado." });
  const code = String(req.body.code || "").trim().toUpperCase();
  const hash = crypto.createHash("sha256").update(code).digest("hex");
  const row = db.prepare("SELECT * FROM access_codes WHERE chat_id=? AND code_hash=? AND used=0 ORDER BY id DESC LIMIT 1").get(chat.id, hash);
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: "La clave no es válida, ya se usó o venció." });
  db.prepare("UPDATE access_codes SET used=1 WHERE id=?").run(row.id);
  req.session.formChatId = chat.id;
  res.json({ ok: true });
});

app.post("/api/chats/:id/form", requireLogin, (req, res) => {
  const user = userFrom(req);
  const chat = getChatForUser(user, Number(req.params.id));
  if (!chat || isAdmin(user) || req.session.formChatId !== chat.id) return res.status(403).json({ error: "Primero tenés que desbloquear el formulario con la clave que te enviaron." });
  if (db.prepare("SELECT id FROM forms WHERE chat_id=?").get(chat.id)) return res.status(400).json({ error: "Este formulario ya fue enviado." });
  const fields = ["projectType", "functions", "language", "server", "details", "budget", "contact"];
  const answers = {};
  for (const field of fields) answers[field] = String(req.body[field] || "").trim().slice(0, 3000);
  if (!answers.projectType || !answers.functions || !answers.details) return res.status(400).json({ error: "Completá el tipo de proyecto, las funciones y los detalles." });
  db.prepare("INSERT INTO forms (chat_id, answers) VALUES (?, ?)").run(chat.id, JSON.stringify(answers));
  addMessage(chat.id, user.id, "¡Listo! Envié el formulario de mi pedido para que lo revises.");
  delete req.session.formChatId;
  res.json({ ok: true });
});

app.get("/api/chats/:id/form", requireLogin, requireAdmin, (req, res) => {
  const chat = db.prepare("SELECT id FROM chats WHERE id=?").get(Number(req.params.id));
  if (!chat) return res.status(404).json({ error: "No se encontró ese chat." });
  const form = db.prepare("SELECT answers, created_at FROM forms WHERE chat_id=?").get(chat.id);
  res.json({ form: form ? { ...form, answers: JSON.parse(form.answers) } : null });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`Ultimate Creations listo en ${BASE_URL}`));
