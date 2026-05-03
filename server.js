const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => console.log(`Server on ${PORT}`));
const wss = new WebSocketServer({ server });

// 게임 설정
const WIDTH = 800;
const HEIGHT = 1200;
const GRID_SIZE = 25;

let gameState = {
    players: {},
    units: [],
    influence: Array(Math.ceil(HEIGHT/GRID_SIZE)).fill().map(() => Array(Math.ceil(WIDTH/GRID_SIZE)).fill(null))
};

// 지형 판정 (한반도 실루엣 기반)
function getTerrain(x, y) {
    // 바다 판정
    if (x < 100 || x > 700 || y < 50 || y > 1150) return 'SEA';
    // 태백산맥 판정 (동쪽 고지대)
    if (x > 550 && y > 200 && y < 600) return 'MOUNTAIN';
    return 'LAND';
}

wss.on('connection', (ws) => {
    const id = `p_${Math.random().toString(36).substr(2, 5)}`;
    const color = `hsl(${Math.random() * 360}, 70%, 50%)`;
    
    gameState.players[id] = { id, color, gold: 100 };
    
    // 초기 유닛 (수도 근처)
    const sx = 300 + Math.random() * 200;
    const sy = 400 + Math.random() * 400;
    gameState.units.push({ id: Date.now() + Math.random(), owner: id, x: sx, y: sy, type: 'INF', hp: 100, tx: sx, ty: sy });

    ws.on('message', (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'MOVE') {
            gameState.units.filter(u => u.owner === id && data.uids.includes(u.id))
                .forEach(u => { u.tx = data.x; u.ty = data.y; });
        }
    });

    ws.on('close', () => {
        delete gameState.players[id];
        gameState.units = gameState.units.filter(u => u.owner !== id);
    });
});

// 게임 루프 (20 FPS)
setInterval(() => {
    // 유닛 이동
    gameState.units.forEach(u => {
        const dx = u.tx - u.x;
        const dy = u.ty - u.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > 5) {
            let speed = 5;
            const terrain = getTerrain(u.x, u.y);
            if (terrain === 'MOUNTAIN') speed = 1.5;
            if (terrain === 'SEA') speed = 1.0; 
            u.x += (dx / dist) * speed;
            u.y += (dy / dist) * speed;
        }
    });

    // 영토 점령 (가까운 유닛 기준)
    for(let i=0; i<gameState.influence.length; i++) {
        for(let j=0; j<gameState.influence[i].length; j++) {
            const gx = j * GRID_SIZE; const gy = i * GRID_SIZE;
            let closest = null; let minDist = 120;
            gameState.units.forEach(u => {
                const d = Math.sqrt((u.x-gx)**2 + (u.y-gy)**2);
                if (d < minDist) { minDist = d; closest = u.owner; }
            });
            gameState.influence[i][j] = closest;
        }
    }

    // 자원 증가
    Object.values(gameState.players).forEach(p => p.gold += 0.05);

    const payload = JSON.stringify(gameState);
    wss.clients.forEach(s => s.readyState === 1 && s.send(payload));
}, 50);
