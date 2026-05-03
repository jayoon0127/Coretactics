const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');
const GameEngine = require('./engine');

const app = express();
const server = app.listen(process.env.PORT || 3000);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const clients = new Map();

wss.on('connection', (ws) => {
    const pid = 'USR-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    clients.set(pid, ws);

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        const room = rooms.get(data.rid);

        switch (data.type) {
            case 'CREATE_ROOM':
                const rid = Math.random().toString(36).substring(2, 6).toUpperCase();
                const engine = new GameEngine(rid, pid, clients);
                rooms.set(rid, engine);
                ws.send(JSON.stringify({ type: 'JOINED', rid, pid, isHost: true }));
                break;

            case 'JOIN_ROOM':
                if (room && room.status === 'LOBBY') {
                    room.addPlayer(pid);
                    ws.send(JSON.stringify({ type: 'JOINED', rid: data.rid, pid, isHost: false }));
                    room.broadcastLobby();
                } else {
                    ws.send(JSON.stringify({ type: 'ERROR', msg: '방이 없거나 이미 시작됨' }));
                }
                break;

            case 'KICK':
                if (room && room.hostId === pid) {
                    room.removePlayer(data.targetId);
                    const targetWs = clients.get(data.targetId);
                    if (targetWs) targetWs.send(JSON.stringify({ type: 'KICKED' }));
                }
                break;

            case 'START_GAME':
                if (room && room.hostId === pid) room.start();
                break;

            case 'ACTION': // 모든 인게임 명령 (이동, 생산, 연구)
                if (room && room.status === 'PLAYING') room.handleAction(pid, data);
                break;
        }
    });

    ws.on('close', () => {
        clients.delete(pid);
        // 여기서 모든 방을 순회하며 플레이어 제거 로직(생략)
    });
});
