const express = require('express');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = app.listen(process.env.PORT || 3000);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. 전역 데이터베이스 (기획안 유닛/기술 스펙)
// ==========================================
const DB = {
    MAP: { W: 1600, H: 2400, GRID: 40 },
    UNITS: {
        INF: { name: '보병', hp: 120, atk: 15, range: 60, speed: 4.5, cost: 50, sci: 0, icon: '🎖️' },
        TANK: { name: '기갑', hp: 350, atk: 40, range: 110, speed: 7.5, cost: 220, sci: 40, icon: '🚜' },
        ARTY: { name: '포병', hp: 80, atk: 60, range: 350, speed: 2.5, cost: 300, sci: 100, icon: '🎯' },
        NAVY: { name: '해군', hp: 600, atk: 55, range: 250, speed: 6.0, cost: 550, sci: 150, icon: '🚢' }
    },
    TECHS: {
        RIFLE: { id: 'RIFLE', name: '강선개량', cost: 150, time: 20000, effect: { type: 'ATK', val: 1.3, target: 'INF' } },
        ENGINE: { id: 'ENGINE', name: '엔진출력', cost: 300, time: 40000, effect: { type: 'SPD', val: 1.2, target: 'TANK' } },
        SUPPLY: { id: 'SUPPLY', name: '보급체계', cost: 250, time: 30000, effect: { type: 'SUPPLY', val: 0.2, target: 'ALL' } }
    }
};

const rooms = new Map();
const clients = new Map();

// ==========================================
// 2. 핵심 게임 엔진 (기획 16개 기능 구현체)
// ==========================================
class GameRoom {
    constructor(rid, hostId) {
        this.rid = rid; this.hostId = hostId;
        this.players = new Map();
        this.units = [];
        this.status = 'LOBBY';
        this.influence = Array(DB.MAP.H/DB.MAP.GRID).fill().map(() => Array(DB.MAP.W/DB.MAP.GRID).fill(null));
        this.tick = 0;
    }

    addPlayer(pid) {
        this.players.set(pid, {
            id: pid, gold: 1000, sci: 0, techs: [], 
            resizing: null, resEndTime: 0, ready: false,
            color: `hsl(${Math.random()*360}, 75%, 55%)`
        });
    }

    start() {
        this.status = 'PLAYING';
        this.players.forEach((p, pid) => {
            const sx = 400 + Math.random()*800, sy = 600 + Math.random()*1200;
            this.spawnUnit(pid, sx, sy, 'INF');
            this.spawnUnit(pid, sx+40, sy+40, 'TANK');
        });
        this.timer = setInterval(() => this.update(), 50);
    }

    spawnUnit(pid, x, y, type) {
        const spec = DB.UNITS[type];
        this.units.push({
            ...spec, id: Math.random(), owner: pid, x, y, tx: x, ty: y,
            curHp: spec.hp, penalty: 1.0, lastAtk: 0
        });
    }

    update() {
        this.tick++;
        this.processPhysics();
        this.processCombat();
        this.processEncirclement();
        this.processEconomy();
        this.sync();
    }

    // [기획 10, 11] 포위/상륙/지형 물리 로직
    processPhysics() {
        this.units.forEach(u => {
            const dx = u.tx - u.x, dy = u.ty - u.y, dist = Math.sqrt(dx*dx + dy*dy);
            if (dist > 5) {
                let speed = u.speed * u.penalty;
                // 지형 판정 (Y 0~500, 1900~2400 바다)
                const isSea = (u.y < 500 || u.y > 1900);
                if (isSea && u.type !== 'NAVY') speed *= 0.35; // 상륙 패널티
                if (!isSea && u.type === 'NAVY') speed = 0.5;   // 해군 육지 이동 불가급 감속
                
                u.x += (dx/dist) * speed; u.y += (dy/dist) * speed;
            }
        });
    }

    // [기획 4, 7] 실시간 전투 로직
    processCombat() {
        this.units.forEach(u => {
            const target = this.units.find(en => 
                en.owner !== u.owner && Math.sqrt((u.x-en.x)**2 + (u.y-en.y)**2) < u.range
            );
            if (target && Date.now() - u.lastAtk > 1000) {
                let dmg = u.atk;
                if (u.type === 'TANK' && target.type === 'INF') dmg *= 1.5; // 상성
                target.curHp -= dmg;
                u.lastAtk = Date.now();
            }
        });
        this.units = this.units.filter(u => u.curHp > 0);
    }

    // [기획 8, 10] 영토 영향력 및 포위 판정
    processEncirclement() {
        if (this.tick % 10 !== 0) return;
        for (let i=0; i<this.influence.length; i++) {
            for (let j=0; j<this.influence[i].length; j++) {
                const gx = j*DB.MAP.GRID, gy = i*DB.MAP.GRID;
                let scores = {};
                this.units.forEach(u => {
                    const d = Math.sqrt((u.x-gx)**2 + (u.y-gy)**2);
                    if (d < 250) scores[u.owner] = (scores[u.owner]||0) + (250-d);
                });
                let best = null, maxS = 0;
                for (let p in scores) { if (scores[p] > maxS) { maxS = scores[p]; best = p; } }
                this.influence[i][j] = best;
            }
        }
        // 보급로 단절 체크 (포위 시 패널티)
        this.units.forEach(u => {
            const gx = Math.floor(u.x/DB.MAP.GRID), gy = Math.floor(u.y/DB.MAP.GRID);
            const isOwner = (this.influence[gy] && this.influence[gy][gx] === u.owner);
            u.penalty = isOwner ? 1.0 : 0.5; // 적지에서 50% 약화
        });
    }

    processEconomy() {
        this.players.forEach(p => {
            p.gold += 0.4; p.sci += 0.15;
            if (p.researching && Date.now() > p.resEndTime) {
                p.techs.push(p.researching); p.researching = null;
            }
        });
    }

    sync() {
        const payload = JSON.stringify({
            type: 'GAME_DATA', rid: this.rid,
            units: this.units, influence: this.influence,
            players: Object.fromEntries(this.players)
        });
        this.players.forEach((_, pid) => clients.get(pid)?.send(payload));
    }
}

// ==========================================
// 3. 네트워크 레이어 (방 관리, 추방, 명령)
// ==========================================
wss.on('connection', (ws) => {
    const pid = 'USR-' + Math.random().toString(36).substring(2, 7).toUpperCase();
    clients.set(pid, ws);

    ws.on('message', (msg) => {
        const d = JSON.parse(msg);
        const room = rooms.get(d.rid);

        switch(d.type) {
            case 'CREATE':
                const rid = Math.random().toString(36).substring(2, 6).toUpperCase();
                const nr = new GameRoom(rid, pid); nr.addPlayer(pid);
                rooms.set(rid, nr);
                ws.send(JSON.stringify({ type: 'JOINED', rid, pid, isHost: true }));
                break;
            case 'JOIN':
                if (room && room.status === 'LOBBY') {
                    room.addPlayer(pid);
                    ws.send(JSON.stringify({ type: 'JOINED', rid: d.rid, pid, isHost: false }));
                }
                break;
            case 'START':
                if (room && room.hostId === pid) room.start();
                break;
            case 'KICK':
                if (room && room.hostId === pid) {
                    clients.get(d.targetId)?.send(JSON.stringify({ type: 'KICKED' }));
                    room.players.delete(d.targetId);
                }
                break;
            case 'CMD':
                if (!room) return;
                const p = room.players.get(pid);
                if (d.cmd === 'MOVE') {
                    room.units.filter(u => u.owner === pid && d.uids.includes(u.id)).forEach(u => { u.tx = d.x; u.ty = d.y; });
                } else if (d.cmd === 'BUY' && p.gold >= DB.UNITS[d.uType].cost) {
                    p.gold -= DB.UNITS[d.uType].cost;
                    room.spawnUnit(pid, d.x, d.y, d.uType);
                } else if (d.cmd === 'TECH' && p.sci >= DB.TECHS[d.tId].cost) {
                    p.sci -= DB.TECHS[d.tId].cost;
                    p.researching = d.tId; p.resEndTime = Date.now() + DB.TECHS[d.tId].time;
                }
                break;
        }
    });
});
