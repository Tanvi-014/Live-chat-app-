const express  = require("express")
const http     = require("http")
const { Server } = require("socket.io")
const Database = require("better-sqlite3")
const crypto   = require("crypto")
const cors     = require("cors")
const path     = require("path")

process.on("uncaughtException",  err => console.error("[uncaughtException]",  err.message))
process.on("unhandledRejection", err => console.error("[unhandledRejection]", err?.message))

console.log("STEP 1 - imports done")

// ── DB ──────────────────────────────────────────────────────────────────────
console.log("STEP 2 - opening database")
const db = new Database(path.join(__dirname, "chat.db"))
console.log("STEP 3 - database opened")
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT    UNIQUE NOT NULL COLLATE NOCASE,
    password TEXT    NOT NULL,
    color    TEXT    NOT NULL DEFAULT '#3b82f6',
    created  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token    TEXT    PRIMARY KEY,
    user_id  INTEGER NOT NULL,
    username TEXT    NOT NULL,
    color    TEXT    NOT NULL,
    created  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    room      TEXT    NOT NULL,
    user      TEXT    NOT NULL,
    color     TEXT    NOT NULL DEFAULT '#3b82f6',
    text      TEXT    NOT NULL,
    timestamp INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    name      TEXT PRIMARY KEY,
    created   INTEGER NOT NULL,
    createdBy TEXT NOT NULL
  );
`)
console.log("STEP 4 - schema created")

// ── Migrations ───────────────────────────────────────────────────────────────
try {
  const cols = db.pragma("table_info(messages)").map(c => c.name)
  if (cols.includes("senderId")) {
    db.exec(`
      CREATE TABLE messages_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL,
        user TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#3b82f6',
        text TEXT NOT NULL, timestamp INTEGER NOT NULL
      );
      INSERT INTO messages_new SELECT id,room,user,COALESCE(color,'#3b82f6'),text,timestamp FROM messages;
      DROP TABLE messages; ALTER TABLE messages_new RENAME TO messages;
    `)
  }
  if (!cols.includes("color"))
    db.exec("ALTER TABLE messages ADD COLUMN color TEXT NOT NULL DEFAULT '#3b82f6'")
} catch (e) { console.error("Migration:", e.message) }

console.log("STEP 5 - migrations done")

// Seed "general" room
db.prepare("INSERT OR IGNORE INTO rooms (name,created,createdBy) VALUES (?,?,?)").run("general", Date.now(), "system")

// ── Queries ───────────────────────────────────────────────────────────────────
const q = {
  createUser:      db.prepare("INSERT INTO users (username,password,color,created) VALUES (?,?,?,?)"),
  findUser:        db.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE"),
  getUserByName:   db.prepare("SELECT id,username,color FROM users WHERE username=? COLLATE NOCASE"),
  createSession:   db.prepare("INSERT INTO sessions (token,user_id,username,color,created) VALUES (?,?,?,?,?)"),
  findSession:     db.prepare("SELECT * FROM sessions WHERE token=?"),
  deleteSession:   db.prepare("DELETE FROM sessions WHERE token=?"),
  updateColor:     db.prepare("UPDATE users    SET color=? WHERE id=?"),
  updateSessColor: db.prepare("UPDATE sessions SET color=? WHERE user_id=?"),

  insertMsg:       db.prepare("INSERT INTO messages (room,user,color,text,timestamp) VALUES (?,?,?,?,?)"),
  getHistory:      db.prepare("SELECT * FROM messages WHERE room=? ORDER BY timestamp ASC LIMIT 200"),
  getMsg:          db.prepare("SELECT * FROM messages WHERE id=?"),
  editMsg:         db.prepare("UPDATE messages SET text=? WHERE id=?"),
  deleteMsg:       db.prepare("DELETE FROM messages WHERE id=?"),
  deleteMsgByRoom: db.prepare("DELETE FROM messages WHERE room=?"),

  getRooms:        db.prepare("SELECT name FROM rooms ORDER BY created ASC"),
  insertRoom:      db.prepare("INSERT OR IGNORE INTO rooms (name,created,createdBy) VALUES (?,?,?)"),
  deleteRoom:      db.prepare("DELETE FROM rooms WHERE name=?"),

  // Get all DM rooms this user has participated in
  getDMRooms:      db.prepare("SELECT DISTINCT room FROM messages WHERE room LIKE 'dm_%' ORDER BY room"),
  getLastMsg:      db.prepare("SELECT text, timestamp, user FROM messages WHERE room=? ORDER BY timestamp DESC LIMIT 1"),
}

function hashPw(pw)          { const s=crypto.randomBytes(16).toString("hex"); return `${s}:${crypto.scryptSync(pw,s,64).toString("hex")}` }
function verifyPw(pw, stored){ try{const[s,h]=stored.split(":");return crypto.timingSafeEqual(Buffer.from(h,"hex"),crypto.scryptSync(pw,s,64))}catch{return false} }
function makeToken()         { return crypto.randomBytes(32).toString("hex") }

// Returns list of past DM contacts for a user: [{username, color, lastText, lastTime}]
function getDMContacts(username) {
  const allRooms = q.getDMRooms.all().map(r => r.room)
  const myRooms  = allRooms.filter(room => {
    const parts = room.slice(3).split("_") // remove "dm_" prefix
    return parts.includes(username)
  })
  return myRooms.map(room => {
    const parts   = room.slice(3).split("_")
    const partner = parts.find(p => p !== username) || username
    const last    = q.getLastMsg.get(room)
    const info    = q.getUserByName.get(partner)
    return {
      username: partner,
      color:    info?.color || "#3b82f6",
      lastText: last?.text  || "",
      lastTime: last?.timestamp || 0,
    }
  }).sort((a, b) => b.lastTime - a.lastTime)
}

// ── Express ──────────────────────────────────────────────────────────────────
const app    = express()
const server = http.createServer(app)
console.log("STEP 6 - express created")
app.use(cors({ origin: true }))
app.use(express.json())

const authMw = (req, res, next) => {
  const session = q.findSession.get(req.headers.authorization?.replace("Bearer ",""))
  if (!session) return res.status(401).json({ error: "Unauthorized" })
  req.session = session; next()
}

app.post("/api/register", (req, res) => {
  const { username, password, color } = req.body
  if (!username?.trim() || !password) return res.status(400).json({ error: "Username and password required" })
  if (username.trim().length < 2)     return res.status(400).json({ error: "Username too short" })
  if (password.length < 4)            return res.status(400).json({ error: "Password min 4 chars" })
  if (q.findUser.get(username.trim())) return res.status(409).json({ error: "Username already taken" })
  try {
    const r = q.createUser.run(username.trim(), hashPw(password), color || "#3b82f6", Date.now())
    const token = makeToken()
    const user  = { id: r.lastInsertRowid, username: username.trim(), color: color || "#3b82f6" }
    q.createSession.run(token, user.id, user.username, user.color, Date.now())
    res.json({ token, user })
  } catch { res.status(500).json({ error: "Registration failed" }) }
})

app.post("/api/login", (req, res) => {
  const { username, password } = req.body
  if (!username?.trim() || !password) return res.status(400).json({ error: "Fill in all fields" })
  const user = q.findUser.get(username.trim())
  if (!user || !verifyPw(password, user.password)) return res.status(401).json({ error: "Wrong username or password" })
  const token = makeToken()
  q.createSession.run(token, user.id, user.username, user.color, Date.now())
  res.json({ token, user: { id: user.id, username: user.username, color: user.color } })
})

app.get("/api/verify", (req, res) => {
  const session = q.findSession.get(req.headers.authorization?.replace("Bearer ",""))
  if (!session) return res.status(401).json({ error: "Invalid session" })
  res.json({ user: { id: session.user_id, username: session.username, color: session.color } })
})

app.post("/api/logout", (req, res) => {
  q.deleteSession.run(req.headers.authorization?.replace("Bearer ",""))
  res.json({ ok: true })
})

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server(server, { cors: { origin: true } })

io.use((socket, next) => {
  const session = q.findSession.get(socket.handshake.auth.token)
  if (!session) return next(new Error("Unauthorized"))
  socket.data.user = { id: session.user_id, username: session.username, color: session.color }
  next()
})

const online = new Map() // socketId → {id, username, color}

function broadcastOnline() {
  io.to("general").emit("users", [...online.values()])
}

function getRoomList() {
  return q.getRooms.all().map(r => r.name)
}

io.on("connection", (socket) => {
  const user = socket.data.user
  console.log(`+ ${user.username}`)

  socket.on("join", () => {
    socket.join("general")
    online.set(socket.id, { id: socket.id, username: user.username, color: user.color })
    broadcastOnline()

    // Send rooms list
    socket.emit("rooms", getRoomList())

    // Send general history
    socket.emit("history", { room: "general", msgs: q.getHistory.all("general") })

    // Send persistent DM contacts
    socket.emit("dmContacts", getDMContacts(user.username))

    socket.to("general").emit("system", `${user.username} joined`)
  })

  // ── Rooms ──────────────────────────────────────────────────────────────────
  socket.on("createRoom", ({ name }) => {
    if (!name || typeof name !== "string") return
    const safe = name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32)
    if (!safe || safe.length < 2) return
    q.insertRoom.run(safe, Date.now(), user.username)
    io.emit("rooms", getRoomList())
  })

  socket.on("deleteRoom", ({ name }) => {
    if (!name || name === "general") return
    q.deleteRoom.run(name)
    q.deleteMsgByRoom.run(name)
    io.emit("rooms", getRoomList())
    io.emit("roomDeleted", { room: name })
  })

  // ── Open DM (fetch history) ────────────────────────────────────────────────
  socket.on("openDM", ({ room }) => {
    socket.join(room)
    socket.emit("history", { room, msgs: q.getHistory.all(room) })
  })

  // ── Room messages ──────────────────────────────────────────────────────────
  socket.on("message", ({ text, room }) => {
    try {
      if (!text?.trim() || !room) return
      const ts  = Date.now()
      const res = q.insertMsg.run(room, user.username, user.color, text.trim(), ts)
      io.to(room).emit("message", {
        id: res.lastInsertRowid, user: user.username,
        color: user.color, text: text.trim(), room, timestamp: ts
      })
    } catch (e) { console.error("[message]", e.message) }
  })

  // ── DM messages ────────────────────────────────────────────────────────────
  socket.on("dm", ({ toUsername, text }) => {
    try {
      if (!text?.trim() || !toUsername) return
      const dmRoom = `dm_${[user.username, toUsername].sort().join("_")}`
      const ts     = Date.now()
      const res    = q.insertMsg.run(dmRoom, user.username, user.color, text.trim(), ts)
      const msg = {
        id: res.lastInsertRowid,
        fromUsername: user.username,
        toUsername,
        color: user.color,
        text: text.trim(),
        room: dmRoom,
        timestamp: ts,
      }

      // Send to sender
      socket.emit("dm", msg)

      // Send to recipient if online
      for (const [sid, u] of online) {
        if (u.username === toUsername) {
          io.to(sid).emit("dm", msg)
          break
        }
      }

      // Refresh DM contacts for both parties
      socket.emit("dmContacts", getDMContacts(user.username))
      for (const [sid, u] of online) {
        if (u.username === toUsername) {
          io.to(sid).emit("dmContacts", getDMContacts(toUsername))
          break
        }
      }
    } catch (e) { console.error("[dm]", e.message) }
  })

  // ── Typing ─────────────────────────────────────────────────────────────────
  socket.on("typing", ({ room, isTyping }) => {
    socket.to(room).emit("typing", { username: user.username, isTyping, room })
  })

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on("disconnect", () => {
    online.delete(socket.id)
    broadcastOnline()
    io.to("general").emit("system", `${user.username} left`)
    console.log(`- ${user.username}`)
  })
})

const PORT = process.env.PORT || 3000;

console.log("STEP 7 - about to listen")
server.listen(PORT, () => {
  console.log(`🟢 Server running on port ${PORT}`);
});