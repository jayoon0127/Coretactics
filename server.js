const express = require('express');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
const wss = new WebSocketServer({ server });

// --- 게임 엔진 설정 ---
const MAP = { WIDTH: 800, HEIGHT: 1200, GRID: 25 };
let state = {
    players: {},
    units: [],
    influence: Array(Math.ceil(MAP.HEIGHT / MAP.GRID)).fill().map(() => Array(Math.ceil(MAP.WIDTH / MAP.GRID)).fill(null))
};

// 지형 판정 (한반도 실루엣)
function checkTerrain(x, y) {
    if (x < 100 || x > 700 || y < 50 || y > 1150) return 'SEA';
    if (x > 530 && y > 150 && y < 650) return 'MOUNTAIN'; // 태백산맥 라인
    return 'LAND';
}

wss.on('connection', (ws) => {
    const pid = `p_${Math.random().toString(36).substr(2, 5)}`;
    const pColor = `hsl(${Math.random() * 360}, 75%, 60%)`;
    
    state.players[pid] = { id: pid, color: pColor, gold: 100, lastUpdate: Date.now() };

    // 초기 유닛 배치 (랜덤 육지)
    let sx = 200 + Math.random() * 400;
    let sy = 300 + Math.random() * 600;
    state.units.push({
        id: Date.now() + Math.random(),
        owner: pid,
        x: sx, y: sy, tx: sx, ty: sy,
        type: 'INF', hp: 100, speed: 4
    });

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'MOVE') {
                state.units.filter(u => u.owner === pid && data.uids.includes(u.id))
                    .forEach(u => { u.tx = data.x; u.ty = data.y; });
            }
        } catch (e) { console.error("Msg Error"); }
    });

    ws.on('close', () => {
        delete state.players[pid];
        state.units = state.units.filter(u => u.owner !== pid);
    });
});

// 핵심 로직 루프 (20 FPS)
setInterval(() => {
    // 1. 유닛 이동 및 지형 패널티 적용
    state.units.forEach(u => {
        const dx = u.tx - u.x;
        const dy = u.ty - u.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist > 3) {
            let currentSpeed = u.speed;
            const terrain = checkTerrain(u.x, u.y);
            if (terrain === 'MOUNTAIN') currentSpeed *= 0.4; // 산악 감속
            if (terrain === 'SEA') currentSpeed *= 0.3;      // 상륙 중 감속
            
            u.x += (dx / dist) * currentSpeed;
            u.y += (dy / dist) * currentSpeed;
        }
    });

    // 2. 영토 영향력 계산 (근접 유닛 기준)
    for (let i = 0; i < state.influence.length; i++) {
        for (let j = 0; j < state.influence[i].length; j++) {
            const gx = j * MAP.GRID; const gy = i * MAP.GRID;
            let closestOwner = null; let minDist = 130;
            state.units.forEach(u => {
                const d = Math.sqrt((u.x - gx) ** 2 + (u.y - gy) ** 2);
                if (d < minDist) { minDist = d; closestOwner = u.owner; }
            });
            state.influence[i][j] = closestOwner;
        }
    }

    // 3. 자원 수급 및 동기화
    Object.values(state.players).forEach(p => p.gold += 0.05);
    const payload = JSON.stringify(state);
    wss.clients.forEach(s => s.readyState === 1 && s.send(payload));
}, 50);
