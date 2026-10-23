

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const PORT = 4000;

const ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173"
];

const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ["GET", "POST"]
    }
});

// roomId -> Map(socket.id -> player)
const rooms = new Map();

// socket.id -> roomId
const socketRooms = new Map();

// --------------------------------------------------
// HTTP ENDPOINTS
// --------------------------------------------------

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

// --------------------------------------------------
// VALIDATION HELPERS
// --------------------------------------------------

function validRoomId(roomId) {
    return (
        typeof roomId === "string" &&
        roomId.trim().length > 0 &&
        roomId.length <= 50
    );
}

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

function validDescription(description, expectedType) {
    return (
        description !== null &&
        typeof description === "object" &&
        description.type === expectedType &&
        typeof description.sdp === "string" &&
        description.sdp.length > 0 &&
        description.sdp.length <= 100000
    );
}

function validIceCandidate(candidate) {
    if (
        candidate === null ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
    ) {
        return false;
    }

    if (
        typeof candidate.candidate !== "string" ||
        candidate.candidate.length > 4096
    ) {
        return false;
    }

    if (
        candidate.sdpMid != null &&
        typeof candidate.sdpMid !== "string"
    ) {
        return false;
    }

    if (
        candidate.sdpMLineIndex != null &&
        (!Number.isInteger(candidate.sdpMLineIndex) ||
            candidate.sdpMLineIndex < 0)
    ) {
        return false;
    }

    if (
        candidate.usernameFragment != null &&
        typeof candidate.usernameFragment !== "string"
    ) {
        return false;
    }

    return true;
}

// --------------------------------------------------
// PLAYER BROADCASTING
// --------------------------------------------------

function broadcastPlayers(roomId) {
    const room = rooms.get(roomId);

    if (!room) return;

    for (const [socketId] of room.entries()) {
        const socket = io.sockets.sockets.get(socketId);

        if (!socket) continue;

        const otherPlayers = [...room.entries()]
            .filter(([otherSocketId]) => otherSocketId !== socketId)
            .map(([, player]) => ({ ...player }));

        socket.emit("players:update", otherPlayers);
    }
}

// --------------------------------------------------
// ROOM CLEANUP
// --------------------------------------------------

function leaveRoom(socket) {
    const roomId = socketRooms.get(socket.id);

    if (!roomId) return;

    const room = rooms.get(roomId);

    if (room) {
        room.delete(socket.id);
    }

    socketRooms.delete(socket.id);
    socket.leave(roomId);

    // Clear stale remote-player state for the leaving client.
    socket.emit("players:update", []);

    console.log(`Client ${socket.id} left room ${roomId}`);

    if (room && room.size === 0) {
        rooms.delete(roomId);
    } else {
        broadcastPlayers(roomId);
    }
}

// --------------------------------------------------
// WEBRTC SIGNALING
// --------------------------------------------------

function relayWebRTC(socket, eventName, data, payload) {
    const roomId = socketRooms.get(socket.id);

    // Sender must have joined the room.
    if (!roomId || data?.roomId !== roomId) {
        console.log("Rejected signaling: room mismatch", socket.id);
        return;
    }

    const targetId = data?.to;

    if (
        typeof targetId !== "string" ||
        targetId.length === 0 ||
        targetId === socket.id
    ) {
        console.log("Rejected signaling: invalid target", socket.id);
        return;
    }

    // Verify the recipient belongs to the sender's room.
    const room = rooms.get(roomId);

    if (!room || !room.has(targetId)) {
        console.log("Rejected signaling: target not in room", targetId);
        return;
    }

    const targetSocket = io.sockets.sockets.get(targetId);

    if (!targetSocket || socketRooms.get(targetId) !== roomId) {
        console.log("Rejected signaling: target disconnected", targetId);
        return;
    }

    targetSocket.emit(eventName, {
        from: socket.id,
        roomId,
        ...payload
    });

    console.log(
        `Relayed ${eventName} from ${socket.id} to ${targetId} in ${roomId}`
    );
}

// --------------------------------------------------
// SOCKET.IO EVENTS
// --------------------------------------------------

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // ----------------------------------------------
    // JOIN ROOM
    // ----------------------------------------------

    socket.on("player:join", (data) => {
        const roomId = data?.roomId;
        const player = data?.player;

        if (
            !validRoomId(roomId) ||
            !player ||
            typeof player.id !== "string" ||
            player.id.trim().length === 0 ||
            player.id.length > 100 ||
            !validPosition(player.x, player.y)
        ) {
            console.log("Invalid player:join payload from", socket.id);
            return;
        }

        // Avoid stale membership when switching rooms.
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
            `${safePlayer.name} joined room ${roomId} ` +
            `at (${safePlayer.x}, ${safePlayer.y})`
        );

        broadcastPlayers(roomId);
    });

    // ----------------------------------------------
    // PLAYER MOVEMENT
    // ----------------------------------------------

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

        broadcastPlayers(roomId);
    });

    // ----------------------------------------------
    // LEAVE ROOM
    // ----------------------------------------------

    socket.on("player:leave", () => {
        leaveRoom(socket);
    });

    // ----------------------------------------------
    // WEBRTC OFFER
    // Payload: { roomId, to, description }
    // ----------------------------------------------

    socket.on("rtc:offer", (data) => {
        if (!validDescription(data?.description, "offer")) {
            console.log("Invalid WebRTC offer from", socket.id);
            return;
        }

        relayWebRTC(socket, "rtc:offer", data, {
            description: data.description
        });
    });

    // ----------------------------------------------
    // WEBRTC ANSWER
    // Payload: { roomId, to, description }
    // ----------------------------------------------

    socket.on("rtc:answer", (data) => {
        if (!validDescription(data?.description, "answer")) {
            console.log("Invalid WebRTC answer from", socket.id);
            return;
        }

        relayWebRTC(socket, "rtc:answer", data, {
            description: data.description
        });
    });

    // ----------------------------------------------
    // ICE CANDIDATE
    // Payload: { roomId, to, candidate }
    // ----------------------------------------------

    socket.on("rtc:ice-candidate", (data) => {
        if (!validIceCandidate(data?.candidate)) {
            console.log("Invalid ICE candidate from", socket.id);
            return;
        }

        relayWebRTC(socket, "rtc:ice-candidate", data, {
            candidate: data.candidate
        });
    });

    // ----------------------------------------------
    // DISCONNECT
    // ----------------------------------------------

    socket.on("disconnect", (reason) => {
        leaveRoom(socket);

        console.log(
            `Client disconnected: ${socket.id}. Reason: ${reason}`
        );
    });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

server.listen(PORT, () => {
    console.log(`ProxiSpeak backend running on port ${PORT}`);
});
