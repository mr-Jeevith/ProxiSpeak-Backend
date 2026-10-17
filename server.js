
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = 4000;

const io = new Server(server, {
    cors: {
        origin: [
            "http://localhost:5173",
            "http://127.0.0.1:5173"
        ],
        methods: ["GET", "POST"]
    }
});

// roomId -> Map(socket.id -> player)
const rooms = new Map();

// socket.id -> roomId
const socketRooms = new Map();

app.get("/", (req, res) => {
    res.send("ProxiSpeak Backend is Running!");
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "ProxiSpeak Backend",
        port: PORT
    });
});

// Validate coordinates
function validPosition(x, y) {
    return (
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= 0 &&
        x <= 1200 &&
        y >= 0 &&
        y <= 720
    );
}

// Send every player the positions of other players in their room
function broadcastPlayers(roomId) {
    const room = rooms.get(roomId);

    if (!room) return;

    for (const [socketId] of room.entries()) {
        const socket = io.sockets.sockets.get(socketId);

        if (!socket) continue;

        const otherPlayers = [...room.entries()]
            .filter(([otherSocketId]) => otherSocketId !== socketId)
            .map(([, player]) => player);

        socket.emit("players:update", otherPlayers);
    }
}

// Remove a client from its current room
function leaveRoom(socket) {
    const roomId = socketRooms.get(socket.id);

    if (!roomId) return;

    const room = rooms.get(roomId);

    room?.delete(socket.id);
    socketRooms.delete(socket.id);
    socket.leave(roomId);

    console.log(`Client ${socket.id} left room ${roomId}`);

    if (room && room.size === 0) {
        rooms.delete(roomId);
    } else {
        broadcastPlayers(roomId);
    }
}

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Join a room and register the player's initial position
    socket.on("player:join", (data) => {
        const roomId = data?.roomId;
        const player = data?.player;

        if (
            typeof roomId !== "string" ||
            roomId.trim().length === 0 ||
            roomId.length > 50 ||
            !player ||
            typeof player.id !== "string" ||
            player.id.length === 0 ||
            !validPosition(player.x, player.y)
        ) {
            console.log("Invalid player:join payload from", socket.id);
            return;
        }

        // A socket can belong to only one room at a time
        leaveRoom(socket);

        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Map());
        }

        const safePlayer = {
            id: player.id,
            name: String(player.name || "Guest").slice(0, 30),
            role: String(player.role || "Participant").slice(0, 35),
            color:
                typeof player.color === "string" &&
                /^#[0-9a-f]{6}$/i.test(player.color)
                    ? player.color
                    : "#8eaaff",
            x: player.x,
            y: player.y
        };

        const room = rooms.get(roomId);

        room.set(socket.id, safePlayer);
        socketRooms.set(socket.id, roomId);
        socket.join(roomId);

        console.log(
            `${safePlayer.name} joined room ${roomId} at (${safePlayer.x}, ${safePlayer.y})`
        );

        broadcastPlayers(roomId);
    });

    // Update a player's position
    socket.on("player:move", (data) => {
        const roomId = socketRooms.get(socket.id);

        if (!roomId || data?.roomId !== roomId) {
            return;
        }

        if (!validPosition(data.x, data.y)) {
            console.log("Invalid movement from", socket.id);
            return;
        }

        const room = rooms.get(roomId);
        const player = room?.get(socket.id);

        if (!player) return;

        player.x = data.x;
        player.y = data.y;

        console.log(
            `Player ${player.id} moved in ${roomId}: (${player.x}, ${player.y})`
        );

        broadcastPlayers(roomId);
    });

    // Explicit room leave, if the frontend uses it
    socket.on("player:leave", () => {
        leaveRoom(socket);
    });

    // Clean up disconnected clients
    socket.on("disconnect", (reason) => {
        leaveRoom(socket);

        console.log(
            `Client disconnected: ${socket.id}. Reason: ${reason}`
        );
    });
});

// Start the HTTP and Socket.IO server
server.listen(PORT, () => {
    console.log(`ProxiSpeak backend running on port ${PORT}`);
});
