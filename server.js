
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "http://127.0.0.1:5500",
        methods: ["GET", "POST"]
    }
});

app.get("/", (req, res) => {
    res.send("ProxiSpeak Backend is Running!");
});


io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Receive avatar coordinates
    socket.on("avatar-move", (data) => {
        console.log("Avatar position:", data);

        // Broadcast to all other connected clients
        socket.broadcast.emit("avatar-update", {
            id: socket.id,
            x: data.x,
            y: data.y
        });
    });

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });
});


server.listen(3000, () => {
    console.log("ProxiSpeak server running on port 3000");
});

