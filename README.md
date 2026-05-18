# 💬 ChatSpace

A real-time chat application with persistent messaging, user authentication, dynamic channels, and direct messages — built with React, Node.js, Socket.IO, and SQLite.

---

## Features

- 🔐 **Persistent login** — register once, stay signed in across page reloads
- 🎨 **Avatar color picker** — choose your color at signup, shown on every message
- 💬 **Channels** — create and delete custom rooms (# general is always there)
- 📩 **Direct Messages** — message anyone, even when they're offline
- 🗂️ **Persistent DM history** — past conversations stay in your sidebar forever
- ⌨️ **Typing indicators** — see when someone is typing in real time
- 😊 **Emoji picker** — quick emoji reactions built in
- 🟢 **Online presence** — green dot shows who's currently online

---

## Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React (Vite) |
| Styling | Vanilla CSS |
| Backend | Node.js + Express |
| Real-time | Socket.IO |
| Database | SQLite via better-sqlite3 |
| Auth | Session tokens (scrypt hashed passwords) |

---

## Project Structure

```
Chat app/
├── client/               # React frontend (Vite)
│   └── src/
│       ├── App.jsx       # Main component — all UI + socket logic
│       ├── App.css       # All styles
│       └── main.jsx      # React entry point
│
└── server/
    ├── index.js          # Express + Socket.IO server
    ├── chat.db           # SQLite database (auto-created)
    └── package.json
```

---

## Getting Started

### 1. Install dependencies

```bash
# Server
cd server
npm install

# Client
cd ../client
npm install
```

### 2. Start the server

```bash
cd server
node index.js
# Server runs on http://localhost:3000
```

### 3. Start the client

```bash
cd client
npm run dev
# App opens at http://localhost:5173
```

---

## How It Works

### Authentication

1. On first visit you see a **login / register** screen.
2. Register with a username, password (min 4 chars), and a color for your avatar.
3. On success the server creates a **session token** and returns it to the client.
4. The token is saved in `localStorage` — so you stay logged in after closing the tab.
5. Every page load calls `/api/verify` with the stored token. If valid, you're taken straight to the chat. If not, you're sent to the login screen.
6. Passwords are hashed with **scrypt + a random salt** — never stored in plain text.

### Channels (Rooms)

- On connect, the server sends the full list of channels from the `rooms` table.
- **general** is seeded at startup and cannot be deleted.
- Click **+** next to "Channels" to create a new one — name is sanitized to lowercase `a-z 0-9 -`.
- Click **×** on any custom channel to delete it. This also wipes all messages in that channel.
- Channel messages are **saved to the database** so history persists across restarts.

### Direct Messages

- Every online user is broadcast to all clients via the `users` socket event.
- When you open a DM, the client emits `openDM` with the deterministic room name (`dm_Alice_Bob`, always alphabetically sorted so both sides use the same key).
- The server joins that socket to the private room and sends back the last 200 messages.
- When you send a DM the server:
  1. Saves the message to the `messages` table under the `dm_*` room name.
  2. Emits it back to you immediately.
  3. Emits it to the recipient's socket if they are online.
- If the recipient is **offline**, the message is still saved. When they next open that conversation, the full history is fetched from the database.
- Past DM conversations appear in your **Messages** sidebar permanently, even if the other person is currently offline, with a preview of the last message.

### Real-time Events

| Event (client → server) | What it does |
|---|---|
| `join` | Joins `general`, gets rooms + history + DM contacts |
| `message` | Sends a message to a channel |
| `dm` | Sends a DM to a user by username |
| `openDM` | Fetches history for a specific DM room |
| `createRoom` | Creates a new channel |
| `deleteRoom` | Deletes a channel and its messages |
| `typing` | Broadcasts typing status to a room |

| Event (server → client) | What it does |
|---|---|
| `users` | Updated list of online users |
| `rooms` | Updated list of channels |
| `dmContacts` | Persistent list of past DM partners from DB |
| `history` | Message history for a room or DM |
| `message` | New channel message |
| `dm` | New direct message |
| `system` | Join/leave notifications |
| `typing` | Someone is (or stopped) typing |
| `roomDeleted` | A channel was deleted |

### Database Schema

```sql
-- Registered users
users (id, username, password, color, created)

-- Active login sessions (token-based)
sessions (token, user_id, username, color, created)

-- All messages — channels and DMs in same table, separated by room name
messages (id, room, user, color, text, timestamp)

-- Channel list (dynamic, persisted)
rooms (name, created, createdBy)
```

DM rooms are stored as `dm_UserA_UserB` (usernames sorted alphabetically) — this guarantees both sides always reference the same room regardless of who initiated the conversation.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/register` | Create account (`username`, `password`, `color`) |
| `POST` | `/api/login` | Sign in, returns session token |
| `GET` | `/api/verify` | Validate a token (used on page load) |
| `POST` | `/api/logout` | Invalidate session token |

---

## Notes

- The SQLite database file (`chat.db`) is created automatically on first run.
- There is no message limit enforced on channels — history loads the last 200 messages per room.
- Typing indicators auto-clear after 1.5 seconds of no input.
- The `general` channel is the presence hub — join/leave notifications are broadcast there.
