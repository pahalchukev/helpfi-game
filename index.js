const express = require('express');
const https = require('https');
const http = require('http');
const socketio = require('socket.io');
const { default: axios } = require('axios');
const fs = require('fs');
const app = express();

const ssl = false;
let server;
if(ssl){
    const sslOptions = {
        cert: fs.readFileSync('/etc/letsencrypt/live/game.helpfi.ua/fullchain.pem'),
        key: fs.readFileSync('/etc/letsencrypt/live/game.helpfi.ua/privkey.pem')
    };
    server = https.createServer(sslOptions, app);
}else{
    server = http.createServer(app);
}

const io = socketio(server, {
    cors: {
        origin: "https://helpfi.ua, https://alpha.helpfi.me",
        methods: ["GET", "POST"]
    }
});

const port = process.env.PORT || 3000;
let firstStart = true;
let pause = false;
const GAME_KEY = ''
// const HOST = 'https://game.helpfi.ua:3000'
const HOST = 'http://localhost'
const lines = { 1: 0, 2: 0, 3: 0 }
const bets = {}
let local_game, game, adv_count = 0;
let stoped = false;
let history = {};


io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    const data = await auth(token)
    if (!data.success) return next(new Error('Unauthorized'));
    if (io.sockets.sockets.get(data.user.id) != undefined) return next(new Error(JSON.stringify({ type: "is_busy" })));
    socket.id = data.user.id
    socket.user = { user: data.user, token: token }
    return next();
});

io.on('connection', async (socket) => {
    if (firstStart || stoped) await takeGame();
    if (bets[socket.id] == undefined)
        bets[socket.id] = { 1: 0, 2: 0, 3: 0 }

    socket.emit('init', { pause, game, lines, rates: bets[socket.id], history })

    socket.on('bet', (data) => bet(socket, data.id));
});


server.listen(port);


const auth = async (token) => {
    let data;
    try {
        let res = await axios.get(`${HOST}/api/v1/games/user`, {
            headers: { Authorization: `Bearer ${token}` }
        })
        data = res.data
    } catch (error) {
        data = error.response.data
    }
    return data;
}


const bet = async (socket, line) => {
    let res;
    let user;
    if (pause || local_game.end <= getTime()) {
        socket.emit('time over')
        return;
    }
    try {
        res = await axios.post(`${HOST}/api/v1/games/${local_game.id}/bets`, { line: line }, {
            headers: { Authorization: `Bearer ${socket.user.token}` }
        })

        if (res.data.success) {
            if (history[game.id] == undefined) {
                history[game.id] = { bets: [], winners: {} }
            }
            socket.emit('change balance', { balance: res.data.balance })
            lines[line] += 0.5;
            bets[socket.id][line] += 0.5
            user = { name: socket.user.user.name, avatar: socket.user.user.avatar }
            history[game.id].bets.push(user);
            io.emit("bet", { user: user, lines: lines })
            socket.emit('user bet', { lines: lines, rates: bets[socket.id] })
        } else {
            if (res.data.message == 'min_balance') {
                socket.emit('min_balance');
            }
        }
    } catch (error) {

    }
}

const takeGame = async () => {
    if (io.sockets.sockets.size == 0) {
        stoped = true;
        return;
    }
    firstStart = false;
    pause = false;
    let res = await axios.get(`${HOST}/api/v1/games`)
    if (!res.data.success) {
        console.error(res);
        io.emit('server error')
    }
    local_game = res.data.game
    game = { id: local_game.id, begin: local_game.start }
    let time = Math.floor(new Date().getTime() / 1000)
    setTimeout(async function () {
        await finishGame(local_game.id)
    }, (local_game.end - time) * 1000)
}


const finishGame = async (id) => {
    io.emit('finish', showAdv());
    const has_bets = hasBets()
    await calcWiners(id);
    clearHistory()
    pause = true;
    resetLines()
    resetBets()
    game = local_game = null;
    setTimeout(async function () {
        await takeGame()
        io.emit('new game', { game, has_bets })
    }, 2 * 1000)
}

const calcWiners = async (id) => {
    let res;
    try {
        if (local_game.id == null) throw new Error('game id  == null')
        res = await axios.post(`${HOST}/api/v1/games/${id}/finish`, { key: GAME_KEY });

        if (res.data.success) {
            if (res.data.winners.length > 0) {
                history[id].winners = res.data.winners;
                io.emit('winners', res.data.winners)
                res.data.winners.map(user => io.to(user.id).emit('local win', user))
            }
        }
    } catch (error) {
    }
}

const resetLines = () => {
    Object.keys(lines).map(line => {
        lines[line] = 0
    })
}

const resetBets = () => {
    Object.keys(bets).map(bet => {
        bets[bet] = { 1: 0, 2: 0, 3: 0 }
    })
}

const getTime = () => {
    return Math.floor(new Date().getTime() / 1000)
}

const hasBets = () => {
    return lines[1] != 0 || lines[2] != 0 && lines[3] != 0
}

const clearHistory = () => {
    const keys = Object.keys(history);
    const lastThreeKeys = keys.slice(-3);
    keys.forEach(key => {
        if (!lastThreeKeys.includes(key)) {
            delete history[key];
        }
    });
}

const showAdv = () => {
    if (adv_count > 4) {
        adv_count = 0;
        return true;
    }
    adv_count++;
    return false;
}