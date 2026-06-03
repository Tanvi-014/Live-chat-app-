import { useEffect, useState, useRef } from "react"
import { io } from "socket.io-client"
import "./App.css"

let socket = null

const EMOJIS = ["😄","😂","😍","🔥","👍","🎉","😢","😡","❤️","💀","🤔","✨","😎","🙏","💯","🤣","😭","🥲","😅","🫡"]
const AVATAR_COLORS = [
  "#3b82f6","#8b5cf6","#ec4899","#f43f5e",
  "#f97316","#eab308","#22c55e","#14b8a6",
  "#06b6d4","#a855f7","#84cc16","#6366f1"
]

export default function App() {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const [authMode,  setAuthMode]  = useState("login")
  const [authUser,  setAuthUser]  = useState("")
  const [authPass,  setAuthPass]  = useState("")
  const [authColor, setAuthColor] = useState(AVATAR_COLORS[0])
  const [authErr,   setAuthErr]   = useState("")
  const [me,        setMe]        = useState(null)   // {id, username, color}
  const [token,     setToken]     = useState(() => localStorage.getItem("chat_token") || "")

  // ── Runtime ───────────────────────────────────────────────────────────────
  const [onlineUsers,  setOnlineUsers]  = useState([])  // [{id, username, color}]
  const [dmContacts,   setDmContacts]   = useState([])  // [{username, color, lastText, lastTime}] from DB
  const [rooms,        setRooms]        = useState([])
  const [activeThread, setActiveThread] = useState(null) // {type:"room"|"dm", id} — id = room name or username
  const [messages,     setMessages]     = useState({})
  const [unread,       setUnread]       = useState({})
  const [message,      setMessage]      = useState("")
  const [showEmoji,    setShowEmoji]    = useState(false)
  const [typing,       setTyping]       = useState({})
  const [typingTimer,  setTypingTimer]  = useState(null)
  const [isConnected,  setIsConnected]  = useState(false)

  // ── Room modal ────────────────────────────────────────────────────────────
  const [showNewRoom, setShowNewRoom] = useState(false)
  const [newRoomName, setNewRoomName] = useState("")
  const [roomErr,     setRoomErr]     = useState("")

  const bottomRef = useRef(null)
  const emojiRef  = useRef(null)

  // thread key: "room:general" or "dm:Alice"
  const threadKey = (t) => t ? `${t.type}:${t.id}` : ""

  // DM room name on server: "dm_Alice_Bob" (sorted)
  const dmRoomName = (a, b) => `dm_${[a, b].sort().join("_")}`

  // ── Restore session ───────────────────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem("chat_token")
    if (!saved) return
    fetch("https://live-chat-app-ntz5.onrender.com/api/verify", {
      headers: { Authorization: `Bearer ${saved}` }
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.user) { setMe(d.user); setToken(saved) }
        else { localStorage.removeItem("chat_token"); setToken("") }
      })
      .catch(() => {})
  }, [])

  // ── Socket lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!me || !token) return

    socket = io("https://live-chat-app-ntz5.onrender.com", { auth: { token } })

    socket.on("connect", () => {
      setIsConnected(true)
      socket.emit("join")
    })

    socket.on("disconnect", () => setIsConnected(false))

    socket.on("users", (users) => setOnlineUsers(users))

    // Persistent DM contacts from DB
    socket.on("dmContacts", (contacts) => {
      setDmContacts(contacts)
    })

    socket.on("rooms", (list) => {
      setRooms(list)
      setActiveThread(prev => prev ?? (list[0] ? { type: "room", id: list[0] } : null))
    })

    // History: works for both rooms and DMs
    socket.on("history", ({ room, msgs }) => {
      let key
      if (room.startsWith("dm_")) {
        // extract partner username from room name
        const parts   = room.slice(3).split("_")
        const partner = parts.find(p => p !== me.username) || parts[0]
        key = `dm:${partner}`
      } else {
        key = `room:${room}`
      }
      setMessages(prev => ({ ...prev, [key]: msgs }))
    })

    // Room message
    socket.on("message", (msg) => {
      const key = `room:${msg.room}`
      setMessages(prev => {
        const arr = prev[key] || []
        if (arr.some(m => m.id === msg.id)) return prev
        return { ...prev, [key]: [...arr, msg] }
      })
      setActiveThread(prev => {
        if (!(prev?.type === "room" && prev.id === msg.room))
          setUnread(u => ({ ...u, [key]: (u[key] || 0) + 1 }))
        return prev
      })
    })

    // DM message — keyed by the OTHER person's username
    socket.on("dm", (msg) => {
      const isMine    = msg.fromUsername === me.username
      const partnerUsername = isMine ? msg.toUsername : msg.fromUsername
      const key       = `dm:${partnerUsername}`
      const enriched  = { ...msg, isMine }

      setMessages(prev => {
        const arr = prev[key] || []
        if (arr.some(m => m.id === msg.id)) return prev
        return { ...prev, [key]: [...arr, enriched] }
      })
      setActiveThread(prev => {
        if (!(prev?.type === "dm" && prev.id === partnerUsername))
          setUnread(u => ({ ...u, [key]: (u[key] || 0) + 1 }))
        return prev
      })
    })

    socket.on("system", (text) => {
      const key = "room:general"
      setMessages(prev => ({
        ...prev,
        [key]: [...(prev[key] || []), { type: "system", text, id: Date.now() + Math.random() }]
      }))
    })

    socket.on("typing", ({ username, isTyping, room }) => {
      let key
      if (room.startsWith("dm_")) {
        const parts   = room.slice(3).split("_")
        const partner = parts.find(p => p !== me.username) || parts[0]
        key = `dm:${partner}`
      } else {
        key = `room:${room}`
      }
      setTyping(prev => {
        const next = { ...prev }
        if (isTyping) next[key] = username
        else delete next[key]
        return next
      })
    })

    socket.on("roomDeleted", ({ room }) => {
      const key = `room:${room}`
      setMessages(prev => { const n = { ...prev }; delete n[key]; return n })
      setActiveThread(prev => prev?.type === "room" && prev.id === room ? null : prev)
    })

    return () => {
      socket.disconnect()
      socket = null
      setIsConnected(false)
      setRooms([])
      setOnlineUsers([])
      setDmContacts([])
    }
  }, [me, token])

  // ── Scroll to bottom ──────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages, activeThread])

  // ── Close emoji picker on outside click ───────────────────────────────────
  useEffect(() => {
    const h = (e) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target)) setShowEmoji(false)
    }
    document.addEventListener("mousedown", h)
    return () => document.removeEventListener("mousedown", h)
  }, [])

  // ── Auth ──────────────────────────────────────────────────────────────────
  const handleAuth = async () => {
    setAuthErr("")
    if (!authUser.trim() || !authPass) { setAuthErr("Fill in all fields"); return }
    const body = authMode === "register"
      ? { username: authUser.trim(), password: authPass, color: authColor }
      : { username: authUser.trim(), password: authPass }
    try {
      const r = await fetch(`https://live-chat-app-ntz5.onrender.com/api/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      })
      const d = await r.json()
      if (!r.ok) { setAuthErr(d.error || "Error"); return }
      localStorage.setItem("chat_token", d.token)
      setToken(d.token)
      setMe(d.user)
    } catch { setAuthErr("Cannot reach server") }
  }

  const handleLogout = () => {
    if (token) fetch("http://localhost:3000/api/logout", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }
    }).catch(() => {})
    localStorage.removeItem("chat_token")
    setToken(""); setMe(null); setMessages({})
    setRooms([]); setOnlineUsers([]); setDmContacts([])
    setActiveThread(null); setIsConnected(false)
  }

  // ── Rooms ─────────────────────────────────────────────────────────────────
  const createRoom = () => {
    const name = newRoomName.trim().toLowerCase()
      .replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
    if (!name || name.length < 2) { setRoomErr("Name must be at least 2 characters"); return }
    if (rooms.includes(name))      { setRoomErr("Room already exists"); return }
    socket.emit("createRoom", { name })
    setShowNewRoom(false); setNewRoomName(""); setRoomErr("")
  }

  const deleteRoom = (e, name) => {
    e.stopPropagation()
    socket.emit("deleteRoom", { name })
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  const switchThread = (t) => {
    setActiveThread(t)
    const key = threadKey(t)
    setUnread(prev => { const n = { ...prev }; delete n[key]; return n })
    if (t.type === "dm") {
      const room = dmRoomName(me.username, t.id)
      socket?.emit("openDM", { room })
    }
  }

  // ── Messaging ─────────────────────────────────────────────────────────────
  const sendMessage = () => {
    if (!message.trim() || !activeThread || !socket) return
    if (activeThread.type === "room") {
      socket.emit("message", { text: message.trim(), room: activeThread.id })
    } else {
      socket.emit("dm", { toUsername: activeThread.id, text: message.trim() })
    }
    setMessage("")
    setShowEmoji(false)
    clearTimeout(typingTimer)
    const tRoom = getTypingRoom()
    if (tRoom) socket.emit("typing", { room: tRoom, isTyping: false })
  }

  const getTypingRoom = () => {
    if (!activeThread) return null
    if (activeThread.type === "room") return activeThread.id
    return dmRoomName(me.username, activeThread.id)
  }

  const handleTyping = (val) => {
    setMessage(val)
    if (!activeThread || !socket) return
    const room = getTypingRoom()
    if (!room) return
    socket.emit("typing", { room, isTyping: true })
    clearTimeout(typingTimer)
    setTypingTimer(setTimeout(() => socket?.emit("typing", { room, isTyping: false }), 1500))
  }

  const formatTime = (ts) => {
    if (!ts) return ""
    const d = new Date(ts)
    const now = new Date()
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    return d.toLocaleDateString([], { month: "short", day: "numeric" })
  }

  // ── Derived data ──────────────────────────────────────────────────────────
  const currentKey  = threadKey(activeThread)
  const currentMsgs = messages[currentKey] || []

  // Merge online users + past DM contacts (avoid duplicates, mark online status)
  const onlineUsernames = new Set(onlineUsers.map(u => u.username))
  const allDMContacts = (() => {
    const map = new Map()
    // Start with past contacts from DB
    dmContacts.forEach(c => map.set(c.username, { ...c, isOnline: false }))
    // Overlay with online users (they may have newer color)
    onlineUsers
      .filter(u => u.username !== me?.username)
      .forEach(u => {
        const existing = map.get(u.username)
        map.set(u.username, { ...(existing || { lastText: "", lastTime: 0 }), ...u, id: u.id, isOnline: true })
      })
    return [...map.values()].sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
  })()

  // Is current DM partner online?
  const dmPartnerOnline = activeThread?.type === "dm"
    ? onlineUsernames.has(activeThread.id)
    : false

  // Current DM partner info
  const dmPartnerInfo = activeThread?.type === "dm"
    ? allDMContacts.find(c => c.username === activeThread.id)
    : null

  // ── LOGIN / REGISTER ──────────────────────────────────────────────────────
  if (!me) {
    return (
      <div className="page">
        <div className="login-box">
          <div className="login-brand">
            <span className="brand-icon">💬</span>
            <h2 className="heading">ChatSpace</h2>
          </div>
          <p className="login-sub">
            {authMode === "login" ? "Welcome back" : "Create your account"}
          </p>

          {authErr && <div className="auth-err">{authErr}</div>}

          <input
            className="input"
            placeholder="Username"
            value={authUser}
            onChange={e => setAuthUser(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAuth()}
            autoFocus
          />
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={authPass}
            onChange={e => setAuthPass(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAuth()}
          />

          {authMode === "register" && (
            <>
              <p className="avatar-picker-label">Pick your avatar color</p>
              <div className="avatar-picker">
                {AVATAR_COLORS.map(c => (
                  <div
                    key={c}
                    className={`avatar-swatch ${authColor === c ? "selected" : ""}`}
                    style={{ background: c }}
                    onClick={() => setAuthColor(c)}
                  />
                ))}
              </div>
              <div className="avatar-preview">
                <div className="avatar" style={{ background: authColor, width: 34, height: 34 }}>
                  {authUser ? authUser[0].toUpperCase() : "?"}
                </div>
                <span>This is how you'll appear in chat</span>
              </div>
            </>
          )}

          <button className="send-btn full-btn" onClick={handleAuth}>
            {authMode === "login" ? "Sign in" : "Create account"}
          </button>

          <p className="toggle-auth">
            {authMode === "login" ? "Don't have an account? " : "Already have one? "}
            <span onClick={() => { setAuthMode(m => m === "login" ? "register" : "login"); setAuthErr("") }}>
              {authMode === "login" ? "Register" : "Sign in"}
            </span>
          </p>
        </div>
      </div>
    )
  }

  // ── MAIN APP ──────────────────────────────────────────────────────────────
  return (
    <div className="page">
      <div className="app-layout">

        {/* ── SIDEBAR ── */}
        <div className="sidebar">

          {/* You */}
          <div className="sidebar-you">
            <div className="avatar" style={{ background: me.color }}>
              {me.username[0]?.toUpperCase()}
            </div>
            <div className="sidebar-userinfo">
              <span className="sidebar-username">{me.username}</span>
              <span className={`conn-dot ${isConnected ? "online" : "offline"}`} />
            </div>
            <button className="logout-btn" onClick={handleLogout} title="Sign out">⏻</button>
          </div>

          {/* Rooms */}
          <div className="sidebar-section-header">
            <span>Channels</span>
            <button className="add-btn" onClick={() => { setShowNewRoom(true); setNewRoomName(""); setRoomErr("") }} title="New room">+</button>
          </div>
          {rooms.map(r => {
            const key    = `room:${r}`
            const active = activeThread?.type === "room" && activeThread.id === r
            return (
              <div
                key={r}
                className={`sidebar-item ${active ? "active" : ""}`}
                onClick={() => switchThread({ type: "room", id: r })}
              >
                <span className="item-icon">#</span>
                <span className="item-label">{r}</span>
                {unread[key] > 0 && <span className="badge">{unread[key]}</span>}
                {r !== "general" && (
                  <button className="delete-room-btn" onClick={(e) => deleteRoom(e, r)} title="Delete">×</button>
                )}
              </div>
            )
          })}

          {/* Direct Messages */}
          <div className="sidebar-section-header" style={{ marginTop: 8 }}>
            <span>Messages</span>
          </div>

          {allDMContacts.length === 0 && (
            <div className="sidebar-empty">No conversations yet</div>
          )}

          {allDMContacts.map(contact => {
            const key    = `dm:${contact.username}`
            const active = activeThread?.type === "dm" && activeThread.id === contact.username
            return (
              <div
                key={contact.username}
                className={`sidebar-dm ${active ? "active" : ""}`}
                onClick={() => switchThread({ type: "dm", id: contact.username })}
              >
                <div className="dm-avatar" style={{ background: contact.color || "#3b82f6" }}>
                  {contact.username[0]?.toUpperCase()}
                  {contact.isOnline && <span className="dm-online-dot" />}
                </div>
                <div className="dm-info">
                  <div className="dm-name">{contact.username}</div>
                  {contact.lastText && (
                    <div className="dm-last">{contact.lastText}</div>
                  )}
                </div>
                {unread[key] > 0 && <span className="badge">{unread[key]}</span>}
              </div>
            )
          })}
        </div>

        {/* ── CHAT PANEL ── */}
        <div className="chat-box">

          {!activeThread ? (
            <div className="no-thread">Choose a channel or start a conversation</div>
          ) : (
            <>
              {/* Header */}
              <div className="chat-header">
                <div className="chat-header-left">
                  {activeThread.type === "dm" && dmPartnerInfo ? (
                    <>
                      <div className="chat-header-avatar" style={{ background: dmPartnerInfo.color || "#3b82f6" }}>
                        {activeThread.id[0]?.toUpperCase()}
                      </div>
                      <h2 className="chat-title">{activeThread.id}</h2>
                    </>
                  ) : (
                    <>
                      <span className="chat-title-icon">#</span>
                      <h2 className="chat-title">{activeThread.id}</h2>
                    </>
                  )}
                </div>
                <span className="you-label">You: {me.username}</span>
              </div>

              {/* Messages */}
              <div className="messages">
                {currentMsgs.length === 0 && (
                  <div className="empty-chat">No messages yet 👋</div>
                )}

                {currentMsgs.map((msg, i) => {
                  if (msg.type === "system") return (
                    <div key={msg.id ?? i} className="system-msg">{msg.text}</div>
                  )

                  const isMine      = activeThread.type === "room" ? msg.user === me.username : msg.isMine
                  const senderName  = activeThread.type === "room" ? msg.user : (isMine ? me.username : msg.fromUsername)
                  const senderColor = msg.color || "#3b82f6"

                  return (
                    <div key={msg.id ?? i} className={`message-wrapper ${isMine ? "mine" : "other"}`}>
                      {!isMine && (
                        <div className="msg-avatar" style={{ background: senderColor }}>
                          {(senderName || "?")[0]?.toUpperCase()}
                        </div>
                      )}
                      <div className="bubble-col">
                        {!isMine && (
                          <div className="bubble-name" style={{ color: senderColor }}>{senderName}</div>
                        )}
                        <div className={`bubble ${isMine ? "mine-bubble" : "other-bubble"}`}>
                          <span className="bubble-text">{msg.text}</span>
                        </div>
                        <span className="timestamp">{formatTime(msg.timestamp)}</span>
                      </div>
                    </div>
                  )
                })}

                {typing[currentKey] && (
                  <div className="typing-indicator">
                    <span className="typing-dots"><span /><span /><span /></span>
                    <span className="typing-name">{typing[currentKey]} is typing…</span>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              {/* Input */}
              <div style={{ position: "relative" }} ref={emojiRef}>
                {showEmoji && (
                  <div className="emoji-picker">
                    {EMOJIS.map(e => (
                      <span key={e} className="emoji-btn"
                        onClick={() => { setMessage(p => p + e); setShowEmoji(false) }}>{e}</span>
                    ))}
                  </div>
                )}
                <div className="bottom-row">
                  <button className="emoji-toggle" onClick={() => setShowEmoji(v => !v)} title="Emoji">😊</button>
                  <input
                    className="input"
                    value={message}
                    onChange={e => handleTyping(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && sendMessage()}
                    placeholder={
                      activeThread.type === "room"
                        ? `Message #${activeThread.id}…`
                        : dmPartnerOnline
                          ? `Message ${activeThread.id}…`
                          : `Message ${activeThread.id} (offline — they'll see it when back)…`
                    }
                  />
                  <button className="send-btn" onClick={sendMessage}>Send</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* New Room Modal */}
      {showNewRoom && (
        <div className="modal-overlay" onClick={() => setShowNewRoom(false)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <h3 className="modal-title">Create a channel</h3>
            <p className="modal-sub">Lowercase letters, numbers, and hyphens only.</p>
            {roomErr && <div className="auth-err">{roomErr}</div>}
            <input
              className="input"
              placeholder="e.g. design, off-topic"
              value={newRoomName}
              onChange={e => setNewRoomName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && createRoom()}
              autoFocus
            />
            <div className="modal-actions">
              <button className="cancel-btn" onClick={() => setShowNewRoom(false)}>Cancel</button>
              <button className="send-btn" onClick={createRoom}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}