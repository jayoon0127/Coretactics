const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = app.listen(process.env.PORT || 3000);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const MAP = { WIDTH: 800, HEIGHT: 1200, GRID: 25 };
const rooms = new Map();
const clients = new Map();

// --- 룸 클래스 (게임의 모든 로직 집약) ---
class GameRoom {
    constructor(id, hostId) {
        this.id = id;
        this.hostId = hostId;
        this.players = {}; // { id: { gold, science, tech: {}, color } }
        this.units = [];
        this.influence = Array(Math.ceil(MAP.HEIGHT/MAP.GRID)).fill().map(() => Array(Math.ceil(MAP.WIDTH/MAP.GRID)).fill(null));
        this.status = 'LOBBY';
        this.timer = null;
    }

    addPlayer(pid) {
        const color = `hsl(${Math.random() * 360}, 70%, 50%)`;
        this.players[pid] = { id: pid, gold: 100, science: 0, tech: { armor: 0, speed: 0, supply: 0 }, color, isHost: pid === this.hostId };
    }

    start() {
        this.status = 'PLAYING';
        // 초기 유닛: 수도(건물 대신 중심점), 보병, 기갑 지급
        Object.keys(this.players).forEach((pid, idx) => {
            const sx = 200 + (idx * 200); const sy = 300 + (idx * 300);
            this.units.push({ id: Math.random(), owner: pid, x: sx, y: sy, tx: sx, ty: sy, type: 'INF', hp: 100, maxHp: 100, lastAtk: 0, penalty: 0 });
            this.units.push({ id: Math.random(), owner: pid, x: sx+30, y: sy+30, tx: sx+30, ty: sy+30, type: 'TANK', hp: 200, maxHp: 200, lastAtk: 0, penalty: 0 });
        });
        this.timer = setInterval(() => this.update(), 50);
    }

    update() {
        this.moveAndTerrain();
        this.resolveCombat();
        this.calculateInfluenceAndSupply();
        this.broadcastState();
    }

    moveAndTerrain() {
        this.units.forEach(u => {
            const dx = u.tx - u.x; const dy = u.ty - u.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist > 5) {
                let speed = u.type === 'TANK' ? 6 : 4;
                // 지형 & 상륙 & 포위 패널티 합산
                if (u.y < 200 || u.y > 1000) speed *= 0.5; // 바다 가상 판정
                if (u.penalty > 0) speed *= 0.5; // 포위/상륙 패널티
                
                u.x += (dx/dist) * speed; u.y += (dy/dist) * speed;
            }
        });
    }

    resolveCombat() {
        this.units.forEach(u => {
            if (u.hp <= 0) return;
            // 가장 가까운 적 찾기
            const target = this.units.find(en => en.owner !== u.owner && en.hp > 0 && Math.sqrt((u.x-en.x)**2 + (u.y-en.y)**2) < 100);
            if (target && Date.now() - u.lastAtk > 1000) {
                const damage = u.type === 'TANK' ? 20 : 10;
                target.hp -= damage;
                u.lastAtk = Date.now();
            }
        });
        this.units = this.units.filter(u => u.hp > 0);
    }

    calculateInfluenceAndSupply() {
        for(let i=0; i<this.influence.length; i++) {
            for(let j=0; j<this.influence[i].length; j++) {
                const gx = j*MAP.GRID; const gy = i*MAP.GRID;
                let closest = null; let minDist = 120;
                this.units.forEach(u => {
                    const d = Math.sqrt((u.x-gx)**2 + (u.y-gy)**2);
                    if(d < minDist) { minDist = d; closest = u.owner; }
                });
                this.influence[i][j] = closest;
            }
        }
        // 포위 판정 (주변 격자가 적군 소유면 패널티)
        this.units.forEach(u => {
            const gx = Math.floor(u.x/MAP.GRID); const gy = Math.floor(u.y/MAP.GRID);
            if(this.influence[gy] && this.influence[gy][gx] !== u.owner) u.penalty = 1;
            else u.penalty = 0;
        });
        // 자원 지급
        Object.values(this.players).forEach(p => { p.gold += 0.1; p.science += 0.05; });
    }

    broadcastState() {
        const msg = JSON.stringify({ type: 'GAME_DATA', units: this.units, players: this.players, influence: this.influence });
        Object.keys(this.players).forEach(pid => clients.get(pid)?.send(msg));
    }
}

wss.on('connection', (ws) => {
    const pid = `p_${Math.random().toString(36).substr(2, 5)}`;
    clients.set(pid, ws);

    ws.on('message', (msg) => {
        const d = JSON.parse(msg);
        if (d.type === 'CREATE') {
            const rid = Math.random().toString(36).substr(2,4).toUpperCase();
            const room = new GameRoom(rid, pid);
            room.addPlayer(pid);
            rooms.set(rid, room);
            ws.send(JSON.stringify({ type: 'JOINED', rid, isHost: true }));
        } else if (d.type === 'JOIN') {
            const room = rooms.get(d.rid);
            if (room) { room.addPlayer(pid); ws.send(JSON.stringify({ type: 'JOINED', rid: d.rid, isHost: false })); }
        } else if (d.type === 'START') {
            rooms.get(d.rid)?.start();
        } else if (d.type === 'MOVE') {
            const room = rooms.get(d.rid);
            if (room) room.units.filter(u => u.owner === pid && d.uids.includes(u.id)).forEach(u => { u.tx = d.x; u.ty = d.y; });
        }
    });
});
